import Moralis from "moralis";
import { EvmChain } from "@moralisweb3/common-evm-utils";
import {collection_abi, factory_abi} from "./abis.js";
import fetch from "cross-fetch";
import { Pool } from "pg"
import { pg as mk_sql_query } from "yesql"
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
    }
}

type NFT = {
    chain: string;
    collection: string;
    token_id: string;
    metadata:{
        name: string;
        description: string;
        image: string;
        external_url: string;
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

    
    let collections : string [] = await call(factory_address, factory_abi, "getAllCollections", [], evm_chain);
    let collections_metadatas = 
        await Promise.all(
            collections.map(x => 
                call(x, collection_abi, "contractURI", [], evm_chain)
                .then((uri:string) => 
                http_get(uri).then(metadata =>
                {return {chain,address:x,metadata}}) ) ));
    let params = collections_metadatas.map((x,i) => `(:chain${i}, :address${i}, :metadata${i}::json)`) 
    let values = collections_metadatas.reduce((acc,x,i) => ({...acc, [`chain${i}`]:x.chain, [`address${i}`]:x.address, [`metadata${i}`]:JSON.stringify(x.metadata)}), {})
    await query(`INSERT INTO nftm.collections VALUES ${params} ON CONFLICT (chain, address) DO nothing;`, values )
    console.log(collections_metadatas)
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
  console.log(`Running on ${PORT}`);
});
