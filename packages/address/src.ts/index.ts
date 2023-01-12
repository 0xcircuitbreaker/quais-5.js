"use strict";

import { arrayify, BytesLike, concat, hexDataLength, hexDataSlice, isHexString, stripZeros } from "@quais/bytes";
import { BigNumber, BigNumberish, _base16To36, _base36To16 } from "@quais/bignumber";
import { formatBytes32String } from "@quais/strings";
import { keccak256 } from "@quais/keccak256";
import { randomBytes } from "@quais/random";
import { encode } from "@quais/rlp";

import { Logger } from "@quais/logger";
import { version } from "./_version";
import { ShardData } from "@quais/constants";

const logger = new Logger(version);

function getChecksumAddress(address: string): string {
    if (!isHexString(address, 20)) {
        logger.throwArgumentError("invalid address", "address", address);
    }

    address = address.toLowerCase();

    const chars = address.substring(2).split("");

    const expanded = new Uint8Array(40);
    for (let i = 0; i < 40; i++) {
        expanded[i] = chars[i].charCodeAt(0);
    }

    const hashed = arrayify(keccak256(expanded));

    for (let i = 0; i < 40; i += 2) {
        if ((hashed[i >> 1] >> 4) >= 8) {
            chars[i] = chars[i].toUpperCase();
        }
        if ((hashed[i >> 1] & 0x0f) >= 8) {
            chars[i + 1] = chars[i + 1].toUpperCase();
        }
    }

    return "0x" + chars.join("");
}

// Shims for environments that are missing some required constants and functions
const MAX_SAFE_INTEGER: number = 0x1fffffffffffff;

function log10(x: number): number {
    if (Math.log10) { return Math.log10(x); }
    return Math.log(x) / Math.LN10;
}


// See: https://en.wikipedia.org/wiki/International_Bank_Account_Number

// Create lookup table
const ibanLookup: { [character: string]: string } = { };
for (let i = 0; i < 10; i++) { ibanLookup[String(i)] = String(i); }
for (let i = 0; i < 26; i++) { ibanLookup[String.fromCharCode(65 + i)] = String(10 + i); }

// How many decimal digits can we process? (for 64-bit float, this is 15)
const safeDigits = Math.floor(log10(MAX_SAFE_INTEGER));

function ibanChecksum(address: string): string {
    address = address.toUpperCase();
    address = address.substring(4) + address.substring(0, 2) + "00";

    let expanded = address.split("").map((c) => { return ibanLookup[c]; }).join("");

    // Javascript can handle integers safely up to 15 (decimal) digits
    while (expanded.length >= safeDigits){
        let block = expanded.substring(0, safeDigits);
        expanded = parseInt(block, 10) % 97 + expanded.substring(block.length);
    }

    let checksum = String(98 - (parseInt(expanded, 10) % 97));
    while (checksum.length < 2) { checksum = "0" + checksum; }

    return checksum;
};

export function getAddress(address: string): string {
    let result = null;

    if (typeof(address) !== "string") {
        logger.throwArgumentError("invalid address", "address", address);
    }

    if (address.match(/^(0x)?[0-9a-fA-F]{40}$/)) {

        // Missing the 0x prefix
        if (address.substring(0, 2) !== "0x") { address = "0x" + address; }

        result = getChecksumAddress(address);

        // It is a checksummed address with a bad checksum
        if (address.match(/([A-F].*[a-f])|([a-f].*[A-F])/) && result !== address) {
            logger.throwArgumentError("bad address checksum", "address", address);
        }

    // Maybe ICAP? (we only support direct mode)
    } else if (address.match(/^XE[0-9]{2}[0-9A-Za-z]{30,31}$/)) {

        // It is an ICAP address with a bad checksum
        if (address.substring(2, 4) !== ibanChecksum(address)) {
            logger.throwArgumentError("bad icap checksum", "address", address);
        }

        result = _base36To16(address.substring(4));
        while (result.length < 40) { result = "0" + result; }
        result = getChecksumAddress("0x" + result);

    } else {
        logger.throwArgumentError("invalid address", "address", address);
    }

    return result;
}

export function isAddress(address: string): boolean {
    try {
        getAddress(address);
        return true;
    } catch (error) { }
    return false;
}

export function getIcapAddress(address: string): string {
    let base36 = _base16To36(getAddress(address).substring(2)).toUpperCase();
    while (base36.length < 30) { base36 = "0" + base36; }
    return "XE" + ibanChecksum("XE00" + base36) + base36;
}

// http://ethereum.stackexchange.com/questions/760/how-is-the-address-of-an-ethereum-contract-computed
export function getContractAddress(transaction: { from: string, nonce: BigNumberish }) {
    let from: string = null;
    try {
        from = getAddress(transaction.from);
    } catch (error) {
        logger.throwArgumentError("missing from address", "transaction", transaction);
    }

    const nonce = stripZeros(arrayify(BigNumber.from(transaction.nonce).toHexString()));

    return getAddress(hexDataSlice(keccak256(encode([ from, nonce ])), 12));
}

export function getCreate2Address(from: string, salt: BytesLike, initCodeHash: BytesLike): string {
    if (hexDataLength(salt) !== 32) {
        logger.throwArgumentError("salt must be 32 bytes", "salt", salt);
    }
    if (hexDataLength(initCodeHash) !== 32) {
        logger.throwArgumentError("initCodeHash must be 32 bytes", "initCodeHash", initCodeHash);
    }
    return getAddress(hexDataSlice(keccak256(concat([ "0xff", getAddress(from), salt, initCodeHash ])), 12))
}

//convert bytes to hex string
function toHexString(byteArray: any) {
    return Array.from(byteArray, function(byte: any) {
        return ('0' + (byte & 0xFF).toString(16)).slice(-2);
    }).join('')
}

// convert hex string to bytes
function toByteArray(hexString: any) {
    var result = [] as any;
    while (hexString.length >= 2) {
        result.push(parseInt(hexString.substring(0, 2), 16));
        hexString = hexString.substring(2, hexString.length);
    }
    return result;
}


export async function grindContractAddress(nonce: number, matchShard: string, sendAddress: string, bytecode: string){
    if (nonce == undefined) {
        logger.throwArgumentError("missing nonce", "nonce", nonce);
    }
    if (matchShard == undefined || !validShard(matchShard)) {
        logger.throwArgumentError("missing matchShard", "matchShard", matchShard);
    }
    
    var salt;
    var contractBytes;
    const nonceBytes = formatBytes32String(nonce.toString());
    var found = false;
    
    while(!found) {
        // replace last two bytes of bytecode with salt
        salt = randomBytes(1);
        var initCode = bytecode.substring(0, bytecode.length-2).concat(toHexString(salt));

        contractBytes = toByteArray(initCode);

        var addressAndNonce = concat([sendAddress, nonceBytes])
        var createInput = concat([addressAndNonce, contractBytes]);
        var preComputedAddress = getAddress(hexDataSlice(keccak256(createInput), 12))

        var shard = getShardFromAddress(preComputedAddress)
        if(shard == undefined) {
            continue 
        }
        if (shard == matchShard) {
            found = true
        }
    }

    return toHexString(contractBytes);
}

export function validShard(shard: string) {
    let shardData = ShardData.filter((obj:any) => {
        return obj.shard == shard
    })
    if (shardData.length === 0) {
        return false
    }
    return true
}

export function getShardFromAddress(address: string) {
    let shardData = ShardData.filter((obj:any) => {
        const num = Number(address.substring(0, 4))
        const start = Number("0x" + obj.byte[0])
        const end = Number("0x" + obj.byte[1])
        return num >= start && num <= end
    })
    if (shardData.length === 0) {
        return null
    }
    return shardData[0].shard
}