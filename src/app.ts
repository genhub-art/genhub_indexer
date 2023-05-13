import {collection_abi, factory_abi} from "./abis.js";
import fetch from "cross-fetch";
import { Pool } from "pg"
import { pg as mk_sql_query } from "yesql"
import * as puppeteer from 'puppeteer';
const { createHash } = require('crypto');
const { ethers } = require("ethers");

const dotenv = require('dotenv');
dotenv.config();

type Collection = {
    chain: string;
    address: string;
    creator: string;
    metadata:{
        name: string;
        description: string;
        image: string;
        external_url: string;
        generator_url: string;
    };
    price: number;
    current_supply: number;
    max_supply: number;
}
type ERCTokenMetadata = {
    name: string;
    description: string;
    image: string;
    external_url: string;
    generator_instance_url: string;
    animation_url: string;
    attributes: {display_type:string; trait_type:string; value:string | number }[];
    properties: object;
}
    
type NFT = {
    chain: string;
    collection: string;
    token_id: string;
    owner: string;
    metadata: ERCTokenMetadata;
};

let sha256 = (x:string) => createHash('sha256').update(x).digest('hex');
let ethersjs_rpc_providers = {
    "bsc_testnet": 'https://data-seed-prebsc-1-s1.binance.org:8545'
}
let call = <a>(address, abi, functionName, params, chain) : Promise<a> => {
    let ethersjs_provider = new ethers.JsonRpcProvider(ethersjs_rpc_providers[chain])
    let ethersjs_contract = new ethers.Contract(address, abi, ethersjs_provider)
    return ethersjs_contract[functionName](...params)
}
let http_get = <a>(url:string): Promise<a> => fetch(url).then(res => res.json() as a);

const pool =  new Pool({connectionString: process.env.DATABASE_URL})

let query = async <a>(x:string, param:any) => {
    const client = await pool.connect()
    try {

        return (await client.query(mk_sql_query(x)(param))).rows as a[]
    }   finally {
        client.release()
    }
}
//old bsc testnet 0x5022cDa25534e0276DabFA1973e54E7B7BC87f56
let dbg = <a>(x:a) => {console.log(x); return x}
let promise_sequential = async <a> (xs: (() => Promise<a>)[]) =>
    xs.reduce(async (acc, x) => [...await acc, await x()], Promise.resolve([] as a[]))
const runApp = async () => {

    try {
        let chains_and_factories =
            await query("select chain, address from nftm.factories", {})
                .then((xs : {chain:string; address:string}[]) => xs.map(x => { return {
                    chain: x.chain,
                    factory_address: x.address,
                }}))
        console.log(chains_and_factories)
        await promise_sequential(chains_and_factories.map(({chain, factory_address}) => async () => {
            console.log("processing chain", chain, "factory", factory_address)
            let collections: string [] = await call(factory_address, factory_abi, "getAllCollections", [], chain);
            console.log(collections)
            let collections_metadatas =
                await promise_sequential(
                    collections.map((collection_address) => async () => {
                            let existing_metadata: {metadata:ERCTokenMetadata}[] = await query("select metadata, current_supply from nftm.collections where chain = :chain and address = :address", {chain, address: collection_address})
                            let uri: string = await call(collection_address, collection_abi, "contractURI", [], chain)
                            let get_creator: string = await call(collection_address, collection_abi, "creator", [], chain).then((x:string) => x.toLowerCase())
                            let get_metadata = http_get(uri.replace("ipfs://", "https://ipfs.moralis.io:2053/ipfs/")).catch(_ => { })
                            let get_price = call(collection_address, collection_abi, "getPrice", [], chain)
                            let get_max_supply = call(collection_address, collection_abi, "getMaxTid", [], chain).then((x) => `${x}`.replace("n",'')).then(Number)
                            let get_current_supply = call(collection_address, collection_abi, "getCurrentTid", [], chain).then((x) => `${x}`.replace("n",'')).then(Number)
                            //do above requests in parallel
                            let metadata = existing_metadata.length > 0 ? existing_metadata[0].metadata : await get_metadata
                            let [creator, price, max_supply, current_supply] = await Promise.all([get_creator, get_price, get_max_supply, get_current_supply])
                            let collection = {
                                chain,
                                address: collection_address,
                                creator,
                                metadata,
                                price,
                                current_supply,
                                max_supply
                            } as Collection
                            if (metadata) {
                                await query("insert into nftm.collections (chain, address, creator, metadata, price, current_supply, max_supply) values (:chain, :address, :creator, :metadata, :price, :current_supply, :max_supply) on conflict (chain, address) do update set creator = :creator, metadata = :metadata, price = :price, current_supply = :current_supply, max_supply = :max_supply", collection)
                                console.log("collection", collection)
                                console.log("current_supply", current_supply as number, "max_supply", max_supply as number)
                                if (current_supply as number > 0) {
                                    let nfts = Array(current_supply as number).fill(0).map((_, i) => { 
                                        console.log("getting nft", i)
                                        return {
                                        chain,
                                        collection: collection_address,
                                        token_id: i.toString(),
                                    }})
                                    
                                    let nfts_metadata: void[] = await promise_sequential(
                                        nfts.map(x => async () => {
                                            // console.log("getting metadata for nft", x)
                                            let already_has_metadata = (await query("select token_id from nftm.nfts where chain = :chain and collection = :collection and token_id = :token_id", x)).length > 0
                                            let owner = await call(collection_address, collection_abi, "ownerOf", [x.token_id], chain)
                                            
                                            if (already_has_metadata) {
                                                // console.log("already_has_metadata", x)
                                                await query("update nftm.nfts set owner = :owner where chain = :chain and collection = :collection and token_id = :token_id", {...x, owner})
                                            } else {
                                                let nft_generator_uri_instance = (metadata as any).generator_url + `/?seed=${sha256(`${process.env.SEED_SHA256_SECRET},${x.chain},${x.collection},${x.token_id}`)}&token_id=${x.token_id}`
                                                console.log("nft_generator_uri_instance", nft_generator_uri_instance)
                                                let browser = await puppeteer.launch({
                                                    executablePath: 'google-chrome-stable',
                                                    // executablePath: '/usr/bin/google-chrome',
                                                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                                                }).catch(e => {
                                                    console.log("puppeteer launch error: ", e);
                                                    return undefined
                                                })
                                                console.log("loaded puppeteer", browser)
                                                let page = await browser.newPage().catch(e => {
                                                    console.log("browser.newPage error: ", e);
                                                    return undefined
                                                })
                                                console.log("page")
                                                await page.goto(nft_generator_uri_instance.replace("ipfs://", "https://ipfs.moralis.io:2053/ipfs/"), {waitUntil: 'networkidle2'});
                                                console.log("page.goto")
                                                //@ts-ignore
                                                let nft_metadata = await page.evaluate(() => metadata()).catch(e => {
                                                    console.log("page.evaluate error: ", e);
                                                    return {}
                                                })
                                                await page.close()
                                                await browser.close()
                                                console.log("nft_metadata", nft_metadata)
                                                let nft_with_metadata = {
                                                    ...x,
                                                    owner,
                                                    metadata: {
                                                        ...nft_metadata,
                                                        generator_instance_url: nft_generator_uri_instance,
                                                        animation_url: nft_generator_uri_instance,
                                                        external_url: nft_generator_uri_instance
                                                    }
                                                } as NFT

                                                await query("insert into nftm.nfts (chain, collection, token_id, owner, metadata) values (:chain, :collection, :token_id, :owner, :metadata::json) on conflict (chain, collection, token_id) do update set owner=excluded.owner, metadata=excluded.metadata", nft_with_metadata)

                                            }

                                        }))
                                    console.log("nfts_metadata", nfts_metadata)
                                }
                                await new Promise(r => setTimeout(r, 30));
                            }
                        }
                    )).catch(e => console.log("promise_sequential error: ", e))
        }))
    } catch (e) { console.log(e)}
};


let loop = async () => {
    await runApp()
    await new Promise(r => setTimeout(r, 10*1000));
    await loop()
}
loop()

