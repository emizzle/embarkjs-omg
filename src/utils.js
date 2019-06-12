import BigNumber from "bn.js";
import { transaction } from "@omisego/omg-js-util";

const DEFAULT_INTERVAL = 1000;
const DEFAULT_BLOCKS_TO_WAIT = 1;

export function confirmTransaction(web3, txnHash, options) {
  const interval = options && options.interval ? options.interval : DEFAULT_INTERVAL;
  const blocksToWait = options && options.blocksToWait ? options.blocksToWait : DEFAULT_BLOCKS_TO_WAIT;
  const transactionReceiptAsync = async function (txnHash, resolve, reject) {
    try {
      const receipt = await web3.eth.getTransactionReceipt(txnHash);
      if (!receipt) {
        return setTimeout(function () {
          transactionReceiptAsync(txnHash, resolve, reject);
        }, interval);
      }
      if (blocksToWait > 0) {
        const resolvedReceipt = await receipt;
        if (!resolvedReceipt || !resolvedReceipt.blockNumber) {
          return setTimeout(function () {
            transactionReceiptAsync(txnHash, resolve, reject);
          }, interval);
        }
        try {
          const block = await web3.eth.getBlock(resolvedReceipt.blockNumber);
          const current = await web3.eth.getBlock('latest');
          if (current.number - block.number >= blocksToWait) {
            const txn = await web3.eth.getTransaction(txnHash);
            // eslint-disable-next-line max-depth
            if (txn.blockNumber !== null) {
              return resolve(resolvedReceipt);
            }
            return reject(new Error('Transaction with hash: ' + txnHash + ' ended up in an uncle block.'));
          }
          return setTimeout(function () {
            transactionReceiptAsync(txnHash, resolve, reject);
          }, interval);
        } catch (e) {
          setTimeout(function () {
            transactionReceiptAsync(txnHash, resolve, reject);
          }, interval);
        }
      } else resolve(receipt);

    } catch (e) {
      reject(e);
    }
  };
  if (Array.isArray(txnHash)) {
    const promises = [];
    txnHash.forEach(function (oneTxHash) {
      promises.push(confirmTransaction(web3, oneTxHash, options));
    });
    return Promise.all(promises);
  }
  return new Promise(function (resolve, reject) {
    transactionReceiptAsync(txnHash, resolve, reject);
  });
}

export function selectUtxos(utxos, amount, currency, includeFee) {
  // Filter by desired currency and sort in descending order
  const sorted = utxos
    .filter(utxo => utxo.currency === currency)
    .sort((a, b) => new BigNumber(b.amount).sub(new BigNumber(a.amount)));

  if (sorted) {
    const selected = [];
    let currentBalance = new BigNumber(0);
    for (let i = 0; i < Math.min(sorted.length, 4); i++) {
      selected.push(sorted[i]);
      currentBalance.iadd(new BigNumber(sorted[i].amount));
      if (currentBalance.gte(new BigNumber(amount))) {
        break;
      }
    }

    if (currentBalance.gte(new BigNumber(amount))) {
      if (includeFee) {
        // Find the first ETH utxo (that's not selected)
        const ethUtxos = utxos.filter(
          utxo => utxo.currency === transaction.ETH_CURRENCY
        );
        const feeUtxo = ethUtxos.find(utxo => utxo !== selected);
        if (!feeUtxo) {
          throw new Error(`Can't find a fee utxo for transaction`);
        } else {
          selected.push(feeUtxo);
        }
      }
      return selected;
    }
  }
}

export function signTypedData (web3, signer, data) {
  return web3.currentProvider.send('eth_signTypedData_v3', [signer, data]);
}

export function normalizeUrl (url) {
  if(!url.endsWith("/")) {
    url += "/";
  }
  return url;
}
