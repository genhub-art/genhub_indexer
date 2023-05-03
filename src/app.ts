import Moralis from "moralis";
import { EvmChain } from "@moralisweb3/common-evm-utils";
import {collection_abi, factory_abi} from "./abis.js";
import fetch from "cross-fetch";
import { Pool } from "pg"
import { pg as mk_sql_query } from "yesql"
import * as puppeteer from 'puppeteer';

const dotenv = require('dotenv');
dotenv.config();

type Collection = {
    chain: string;
    address: string;
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

type NFT = {
    chain: string;
    collection: string;
    token_id: string;
    owner: string;
    metadata:{
        name: string;
        description: string;
        image: string;
        external_url: string;
        generator_instance_url: string;
        animation_url: string;
        attributes: {name:string; value:string}[];
    }
};

let call = <a>(address, abi, functionName, params, chain) : Promise<a> => Moralis.EvmApi.utils.runContractFunction({
    address,
    abi,
    functionName,
    params,
    chain,
}).then(x => x.toJSON() as a);
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
let dbg = <a>(x:a) => {console.log(x); return x}
let promise_sequential = async <a> (xs: (() => Promise<a>)[]) =>
    xs.reduce(async (acc, x) => [...await acc, await x()], Promise.resolve([] as a[]))
const runApp = async () => {
    try{
    await Moralis.start({
        apiKey: "ArBIlASMaBR3Z9cs9sT7K7eHYt4knMUUJQzZ9vGJKf3XSeXwyQqXaOAWbnRfO9Vl",
        // ...and any other configuration
    });
    } catch (e) {}
    let chain = "bsc_testnet"
    const evm_chain = chain == "bsc_testnet" ? EvmChain.BSC_TESTNET : EvmChain.BSC;

    const factory_address = "0x9493a61C8DBA11b0c3428cE947fb20CA7b2016f1";

    try {
        let collections: string [] = await call(factory_address, factory_abi, "getAllCollections", [], evm_chain);
        console.log(collections)
        let browser = await  puppeteer.launch({
            executablePath: '/usr/bin/google-chrome',
            args: ['--no-sandbox', '--disable-setuid-sandbox']})
        let collections_metadatas =
            await promise_sequential(
                collections.map((collection_address) => async () => {
                    let uri : string = await call(collection_address, collection_abi, "contractURI", [], evm_chain)
                    let get_metadata = http_get(uri.replace("ipfs://", "https://ipfs.moralis.io:2053/ipfs/")).catch(_ => { })
                    let get_price = call(collection_address, collection_abi, "getPrice", [], evm_chain)
                    let get_max_supply = call(collection_address, collection_abi, "getMaxTid", [], evm_chain)
                    let get_current_supply = call(collection_address, collection_abi, "getCurrentTid", [], evm_chain)
                    //do above requests in parallel
                    let [metadata, price, max_supply, current_supply] = await Promise.all([get_metadata, get_price, get_max_supply, get_current_supply])
                    if (current_supply as number > 0) {
                        let nfts_id_owner = await Moralis.EvmApi.nft.getNFTOwners({
                            address: collection_address,
                            chain: evm_chain,
                            format: "decimal",
                            mediaItems: false
                        }).then(xs => xs.raw.result.map(x => {
                            return {chain, collection: collection_address, token_id: x.token_id, owner: x.owner_of}
                        }))
                        console.log("nfts_id_owner", nfts_id_owner)
                        let nfts_metadata: NFT[] = await promise_sequential(nfts_id_owner.map(x => async () => {
                            let nft_generator_uri_instance = (metadata as any).generator_url + "/?gxhash=" + x.token_id
                            console.log("nft_generator_uri_instance", nft_generator_uri_instance)
                            let page = await browser.newPage()
                            console.log("page")
                            await page.goto(nft_generator_uri_instance.replace("ipfs://", "https://ipfs.moralis.io:2053/ipfs/"), {waitUntil: 'networkidle2'});
                            console.log("page.goto")
                            //@ts-ignore
                            let nft_metadata = await page.evaluate(() =>  gxmetadata())
                            console.log("nft_metadata", nft_metadata)
                            return {
                                ...x,
                                metadata: {
                                    ...nft_metadata,
                                    generator_instance_url: nft_generator_uri_instance,
                                    animation_url: nft_generator_uri_instance,
                                    external_url: nft_generator_uri_instance
                                }
                            } as NFT
                        }))
                        console.log("nfts_metadata", nfts_metadata)
                        //insert nfts into nftm.nfts
                        let params = nfts_metadata.map((x, i) => `(:chain${i}, :collection${i}, :token_id${i}, :owner${i}, :metadata${i}::json)`).join(", ")
                        let values = nfts_metadata.reduce((acc, x, i) => ({
                            ...acc,
                            [`chain${i}`]: x.chain,
                            [`collection${i}`]: x.collection,
                            [`token_id${i}`]: x.token_id,
                            [`owner${i}`]: x.owner,
                            [`metadata${i}`]: JSON.stringify(x.metadata)
                        }), {})
                        
                        await query(dbg(`INSERT INTO nftm.nfts (chain, collection, token_id, owner, metadata) VALUES ${params} ON CONFLICT (chain, collection, token_id) do update set owner=excluded.owner;`), values).catch(e => console.log(e))
                    }
                    await new Promise(r => setTimeout(r, 300));
                    return dbg({chain, address: collection_address, metadata, price, current_supply, max_supply} as Collection)
                    }
                )).catch(_ => [] as Collection[]);
        await browser.close()
        let params = collections_metadatas.map((x,i) => `(:chain${i}, :address${i}, :metadata${i}::json, :price${i}, :current_supply${i}, :max_supply${i})`).join(", ")
        let values = collections_metadatas.reduce((acc,x,i) => ({...acc, [`chain${i}`]:x.chain, [`address${i}`]:x.address, [`metadata${i}`]:JSON.stringify(x.metadata), [`price${i}`]:x.price, [`max_supply${i}`]:x.max_supply, [`current_supply${i}`]:x.current_supply}), {})
        await query(`INSERT INTO nftm.collections (chain, address, metadata, price, current_supply, max_supply) VALUES ${params} ON CONFLICT (chain, address) DO update set metadata = excluded.metadata, price = excluded.price, current_supply = excluded.current_supply, max_supply = excluded.max_supply;`, values )
    } catch (e) { console.log(e)}
};



'use strict';

const express = require('express');

// Constants
const PORT = 8080;

// App
const app = express();
app.get('/', (req, res) => {
    
  runApp().then(() => res.send('Done'));
});

app.listen(PORT, () => {
  console.log(`Running on http://localhost:${PORT}`);
});
