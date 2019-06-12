/* global web3, ethereum */
import {
  confirmTransaction,
  normalizeUrl,
  selectUtxos,
  signTypedData
} from "./utils";
import BigNumber from "bn.js";
import ChildChain from "@omisego/omg-js-childchain";
import RootChain from "@omisego/omg-js-rootchain";
import { transaction } from "@omisego/omg-js-util";

const web3Options = { transactionConfirmationBlocks: 1 };

export default class BaseEmbarkOmg {
  constructor({ pluginConfig, logger }) {
    this.logger = logger;
    this.initing = false;
    this.inited = false;
    this.address = "";
    this.addressPrivateKey = "";
    this.maxDeposit = 0;

    // plugin opts
    this.plasmaContractAddress =
      pluginConfig.PLASMA_CONTRACT_ADDRESS ||
      "0x740ecec4c0ee99c285945de8b44e9f5bfb71eea7";
    this.watcherUrl = normalizeUrl(
      pluginConfig.WATCHER_URL || "https://watchersamrong.omg.network/"
    );
    this.childChainUrl = normalizeUrl(
      pluginConfig.CHILDCHAIN_URL || "https://samrong.omg.network/"
    );
    this.childChainExplorerUrl = normalizeUrl(
      pluginConfig.CHILDCHAIN_EXPLORER_URL ||
        "https://quest.samrong.omg.network"
    );
  }

  async initWeb3() {
    if (window.ethereum) {
      this.web3 = new Web3(window.ethereum, null, web3Options);
      try {
        // Request account access
        await ethereum.enable();
        return true;
      } catch (err) {
        // User denied account access :(
        console.error(err);
      }
    } else if (window.web3) {
      this.web3 = new Web3(window.web3.currentProvider, null, web3Options);
      return true;
    }
    // No web3...
    return false;
  }

  async init(web3) {
    //}, web3Path) {

    try {
      if (this.initing) {
        const message = "Already intializing the Plasma chain, please wait...";
        throw new Error(message);
      }
      this.initing = true;

      // if (!(await this.initWeb3())) {
        this.web3 = web3;
      // }
      let accounts = await this.web3.eth.getAccounts();
      this.address = accounts.length > 1 ? accounts[1] : accounts[0]; // ignore the first account because it is our deployer account, we want the manually added account
      // check account balance on the main chain
      // try {
      //   this.maxDeposit = await this.web3.eth.getBalance(this.address);
      //   if (!this.maxDeposit || new BigNumber(this.maxDeposit).lte(0)) {
      //     throw new Error("The configured account does not have enough funds. Please make sure this account has Rinkeby ETH.");
      //   }
      //   this.maxDeposit = new BigNumber(this.maxDeposit);
      // }
      // catch (e) {
      //   this.logger.warn(`Error getting balance for account ${this.address}: ${e}`);
      // }

      // set up the Plasma chain
      this.rootChain = new RootChain(this.web3, this.plasmaContractAddress);
      this.childChain = new ChildChain(this.watcherUrl); //, this.childChainUrl);

      // set lifecycle state vars
      this.initing = false;
      this.inited = true;
    } catch (e) {
      const message = `Error initializing Plasma chain: ${e}`;
      throw new Error(message);
    }
  }

  async deposit(amount) {
    // TODO: Update this to support ERC-20's
    const currency = transaction.ETH_CURRENCY;
    const approveDeposit = false;
    const erc20abi = {};

    if (!this.inited) {
      const message = "Please wait for the Plasma chain to initialize...";
      throw new Error(message);
    }
    amount = new BigNumber(amount);
    if (!amount || amount.lte(0)) {
      const message = "You must deposit more than 0 wei.";
      throw new Error(message);
    }
    // if (amount.gt(this.maxDeposit) && this.maxDeposit.gt(0)) {
    //   // recheck balance in case it was updated in a recent tx
    //   this.maxDeposit = await this.web3.eth.getBalance(this.address);
    //   if (amount.gt(this.maxDeposit)) {
    //     const message = `You do not have enough funds for this deposit. Please deposit more funds in to ${this.address} and then try again.`;
    //     throw new Error(message);
    //   }
    // }
    // Create the deposit transaction
    const depositTx = transaction.encodeDeposit(this.address, amount, currency);

    if (currency === transaction.ETH_CURRENCY) {
      this.logger.info(`Depositing ${amount} wei...`);
      // ETH deposit
      try {
        const receipt = await this.rootChain.depositEth(depositTx, amount, {
          from: this.address
        });
        this.logger.trace(receipt);
        const message = `Successfully deposited ${amount} wei in to the Plasma chain.\nView the transaction: https://rinkeby.etherscan.io/tx/${
          receipt.transactionHash
        }`;
        return message;
      } catch (e) {
        const message = `Error depositing ${amount} wei: ${e}`;
        throw new Error(message);
      }
    }

    // ERC20 token deposit
    if (approveDeposit) {
      // First approve the plasma contract on the erc20 contract
      const erc20 = new this.web3.eth.Contract(erc20abi, currency);
      // const approvePromise = Promise.promisify(erc20.approve.sendTransaction)

      // TODO
      const gasPrice = 1000000;
      const receipt = await erc20.methods
        .approve(this.rootChain.plasmaContractAddress, amount)
        .send({ from: this.address, gasPrice, gas: 2000000 });
      // Wait for the approve tx to be mined
      this.logger.info(
        `${amount} erc20 approved: ${
          receipt.transactionHash
        }. Waiting for confirmation...`
      );
      await confirmTransaction(this.web3, receipt.transactionHash);
      this.logger.info(`... ${receipt.transactionHash} confirmed.`);
    }

    return this.rootChain.depositToken(depositTx, { from: this.address });
  }

  async transfer(toAddress, amount) {
    // TODO: Update this to support ERC20's
    const currency = transaction.ETH_CURRENCY;
    const verifyingContract = this.plasmaContractAddress;

    const transferZeroFee = currency !== transaction.ETH_CURRENCY;
    const utxos = await this.childChain.getUtxos(this.address);
    const utxosToSpend = selectUtxos(utxos, amount, currency, transferZeroFee);
    if (!utxosToSpend) {
      throw new Error(`No utxo big enough to cover the amount ${amount}`);
    }

    const txBody = {
      inputs: utxosToSpend,
      outputs: [
        {
          owner: toAddress,
          currency,
          amount: amount.toString()
        }
      ]
    };

    const bnAmount = new BigNumber(utxosToSpend[0].amount);
    if (bnAmount.gt(new BigNumber(amount))) {
      // Need to add a 'change' output
      const CHANGE_AMOUNT = bnAmount.sub(new BigNumber(amount));
      txBody.outputs.push({
        owner: this.address,
        currency,
        amount: CHANGE_AMOUNT
      });
    }

    if (transferZeroFee && utxosToSpend.length > 1) {
      // The fee input can be returned
      txBody.outputs.push({
        owner: this.address,
        currency: utxosToSpend[utxosToSpend.length - 1].currency,
        amount: utxosToSpend[utxosToSpend.length - 1].amount
      });
    }

    // Get the transaction data
    const typedData = transaction.getTypedData(txBody, verifyingContract);

    // We should really sign each input separately but in this we know that they're all
    // from the same address, so we can sign once and use that signature for each input.
    //
    // const sigs = await Promise.all(utxosToSpend.map(input => signTypedData(web3, web3.utils.toChecksumAddress(from), typedData)))
    //
    const signature = await signTypedData(
      this.web3,
      this.web3.utils.toChecksumAddress(this.address),
      JSON.stringify(typedData)
    );
    // const signer = this.web3.utils.toChecksumAddress(this.address);
    // const data = JSON.stringify(typedData);
    // const signature = this.web3.currentProvider.send("eth_signTypedData_v3", [
    //   signer,
    //   data
    // ]);
    const sigs = new Array(utxosToSpend.length).fill(signature);

    // Build the signed transaction
    const signedTx = this.childChain.buildSignedTransaction(typedData, sigs);
    // Submit the signed transaction to the childchain
    const result = await this.childChain.submitTransaction(signedTx);

    const message = `Successfully submitted tx on the child chain: ${JSON.stringify(
      result
    )}\nView the transaction: ${this.childChainExplorerUrl}transaction/${
      result.txhash
    }`;

    return message;
  }

  async exit(fromAddress) {
    const utxos = await this.childChain.getUtxos(fromAddress);
    if (utxos.length <= 0) {
      const message = `No UTXOs found on the Plasma chain for ${fromAddress}.`;
      throw new Error(message);
    }
    // NB This only exits the first UTXO.
    // Selecting _which_ UTXO to exit is left as an exercise for the reader...
    const errors = [];
    utxos.forEach(async utxo => {
      const exitData = await this.childChain.getExitData(utxo);

      try {
        let receipt = await this.rootChain.startStandardExit(
          Number(exitData.utxo_pos.toString()),
          exitData.txbytes,
          exitData.proof,
          {
            from: fromAddress
          }
        );
        return `Exited UTXO from address ${fromAddress} with value ${
          utxo.amount
        }. View the transaction: https://rinkeby.etherscan.io/tx/${
          receipt.transactionHash
        }`;
      } catch (e) {
        const message = `Error exiting the Plasma chain for UTXO ${JSON.stringify(
          utxo
        )}: ${e}`;
        errors.push(message);
      }
    });
    if (errors.length) {
      throw new Error(errors.join("\n\n"));
    }
  }

  selectUtxos(utxos, amount, currency) {
    const correctCurrency = utxos.filter(utxo => utxo.currency === currency);
    // Just find the first utxo that can fulfill the amount
    const selected = correctCurrency.find(utxo =>
      new BigNumber(utxo.amount).gte(new BigNumber(amount))
    );
    if (selected) {
      return [selected];
    }
  }
}
