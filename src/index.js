/* global EmbarkJS */
import BigNumber from "bn.js";
import ChildChain from "@omisego/omg-js-childchain";
import RootChain from "@omisego/omg-js-rootchain";
import { transaction } from "@omisego/omg-js-util";

const ACCOUNT_CONFIG_ERROR = "Blockchain accounts configuration is missing. To use the Embark-OMG plugin, you must configure blockchain accounts to use either a private key file, a private key, or a mnemonic.";
const ACCOUNT_BALANCE_ERROR = "The configured account does not have enough funds. Please make sure this account has Rinkeby ETH.";

export default class BaseEmbarkOmg {
  constructor({ pluginConfig, logger }) {
    this.logger = logger;
    this.initing = false;
    this.inited = false;
    this.address = "";
    this.addressPrivateKey = "";
    this.maxDeposit = 0;


    // plugin opts
    this.plasmaContractAddress = pluginConfig.PLASMA_CONTRACT_ADDRESS;
    //this.web3ProviderUrl = pluginConfig.WEB3_PROVIDER_URL;
    this.watcherUrl = pluginConfig.WATCHER_URL;
    this.childChainUrl = pluginConfig.CHILDCHAIN_URL;
  }

  async init(web3) { //}, web3Path) {

    try {
      if (this.initing) {
        const message = "Already intializing the Plasma chain, please wait...";
        //this.logger.error(message);
        throw new Error(message);
      }
      this.initing = true;

      // if (!(accounts && accounts.length)) {
      //   //this.logger.error(ACCOUNT_CONFIG_ERROR);
      //   throw new Error(ACCOUNT_CONFIG_ERROR);
      // }
      //const { address, privateKey } = accounts[0];
      //this.address = address;
      //this.addressPrivateKey = privateKey;

      // this.address = accounts[0];


      // init Web3
      // const web3Lib = web3Path ? require(web3Path) : Web3;
      // this.web3 = new web3Lib();
      // if (!web3) {
      //   web3 = EmbarkJS.Blockchain.providers["web3"];
      // }
      this.web3 = web3;
      let accounts = await this.web3.eth.getAccounts();
      this.address = accounts.length > 1 ? accounts[1] : accounts[0]; // ignore the first account because it is our deployer account, we want the manually added account

      // if(!this.web3) {
      //   throw new Error("web3 cannot be found. Please ensure you have the 'embarkjs-connector-web3' plugin installed in your DApp.");
      // }
      // const web3Provider = new web3Lib.providers.HttpProvider(this.web3ProviderUrl);
      //this.web3.setProvider(web3Provider);

      // check account balance on the main chain
      // try {
      //   this.maxDeposit = await this.web3.eth.getBalance(this.address);
      //   if (!this.maxDeposit || new BigNumber(this.maxDeposit).lte(0)) {
      //     //this.logger.error(ACCOUNT_BALANCE_ERROR);
      //     throw new Error(ACCOUNT_BALANCE_ERROR);
      //   }
      //   this.maxDeposit = new BigNumber(this.maxDeposit);
      // }
      // catch (e) {
      //   this.logger.warn(`Error getting balance for account ${this.address}: ${e}`);
      // }

      // set up the Plasma chain
      this.rootChain = new RootChain(this.web3, this.plasmaContractAddress);
      this.childChain = new ChildChain(this.watcherUrl, this.childChainUrl);

      // set lifecycle state vars
      this.initing = false;
      this.inited = true;
    }
    catch (e) {
      const message = `Error initializing Plasma chain: ${e}`;
      //this.logger.error(message);
      throw new Error(message);
    }
  }

  async deposit(amount) {
    if (!this.inited) {
      const message = "Please wait for the Plasma chain to initialize...";
      // this.logger.error(message);
      throw new Error(message);
    }
    amount = new BigNumber(amount);
    if (!amount || amount.lte(0)) {
      const message = "You must deposit more than 0 wei.";
      // this.logger.error(message);
      throw new Error(message);
    }
    // if (amount.gt(this.maxDeposit) && this.maxDeposit.gt(0)) {
    //   // recheck balance in case it was updated in a recent tx
    //   this.maxDeposit = await this.web3.eth.getBalance(this.address);
    //   if (amount.gt(this.maxDeposit)) {
    //     const message = `You do not have enough funds for this deposit. Please deposit more funds in to ${this.address} and then try again.`;
    //     // this.logger.error(message);
    //     throw new Error(message);
    //   }
    // }
    // const DEPOSIT_AMT = "100000";
    this.logger.info(`Depositing ${amount} wei...`);
    const depositTx = transaction.encodeDeposit(this.address, amount, transaction.ETH_CURRENCY);
    try {
      const receipt = await this.rootChain.depositEth(depositTx, amount, { from: this.address });//, privateKey: this.addressPrivateKey });
      this.logger.trace(receipt);
      const message = `Successfully deposited ${amount} wei in to the Plasma chain.\nView the transaction: https://rinkeby.etherscan.io/tx/${receipt.transactionHash}`;
      // this.logger.info(message);
      return message;
    }
    catch (e) {
      const message = `Error depositing ${amount} wei: ${e}`;
      // this.logger.error(message);
      throw new Error(message);
    }
  }

  async send(toAddress, val) {
    //const val = "555";
    // const toAddress = "0x38d5beb778b6e62d82e3ba4633e08987e6d0f990";
    const utxos = await this.childChain.getUtxos(this.address);
    const utxosToSpend = this.selectUtxos(utxos, val, transaction.ETH_CURRENCY);
    if (!utxosToSpend) {
      throw new Error(`No utxo big enough to cover the amount ${val}`);
    }
    val = new BigNumber(val);
    if (!val || val.lte(0)) {
      throw new Error("Transaction value must be more than 0 wei.");
    }

    const txBody = {
      inputs: utxosToSpend,
      outputs: [
        {
          owner: toAddress,
          currency: transaction.ETH_CURRENCY,
          amount: val
        }
      ]
    };

    const utxoAmnt = new BigNumber(utxosToSpend[0].amount);
    if (utxoAmnt.gt(val)) {
      // specify the change amount back to yourself
      const changeAmnt = utxoAmnt.sub(val);
      txBody.outputs.push({
        owner: this.address,
        currency: transaction.ETH_CURRENCY,
        amount: changeAmnt
      });
    }

    try {
      const unsignedTx = await this.childChain.createTransaction(txBody);

      const signatures = await this.childChain.signTransaction(unsignedTx);//, [this.addressPrivateKey]);

      const signedTx = await this.childChain.buildSignedTransaction(unsignedTx, signatures);

      const result = await this.childChain.submitTransaction(signedTx);

      const message = `Successfully submitted tx on the child chain: ${JSON.stringify(result)}\nView the transaction: http://quest.ari.omg.network/transaction/${result.txhash}`;

      //this.logger.info(message);
      return message;
    }
    catch (e) {
      // this.logger.error(e);
      throw e;
    }
  }

  async exit(fromAddress) {
    const utxos = await this.childChain.getUtxos(fromAddress);
    if (utxos.length <= 0) {
      const message = `No UTXOs found on the Plasma chain for ${fromAddress}.`;
      this.logger.error(message);
      throw new Error(message);
    }
    // NB This only exits the first UTXO.
    // Selecting _which_ UTXO to exit is left as an exercise for the reader...
    const errors = [];
    utxos.forEach(async (utxo) => {
      const exitData = await this.childChain.getExitData(utxo);

      try {
        let receipt = await this.rootChain.startStandardExit(
          exitData.utxo_pos.toString(),
          exitData.txbytes,
          exitData.proof,
          {
            from: fromAddress
          }
        );
        const message = `Exited UTXO from address ${fromAddress} with value ${utxo.amount}. View the transaction: https://rinkeby.etherscan.io/tx/${receipt.transactionHash}`;
        // this.logger.info(message);
        return message;
      }
      catch (e) {
        const message = `Error exiting the Plasma chain for UTXO ${JSON.stringify(utxo)}: ${e}`;
        // this.logger.error(message);
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
    const selected = correctCurrency.find(utxo => new BigNumber(utxo.amount).gte(new BigNumber(amount)));
    if (selected) {
      return [selected];
    }
  }
}
