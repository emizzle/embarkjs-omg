
import { BigNumber } from "ethers/utils";
import ChildChain from "@omisego/omg-js-childchain";
import EmbarkUtils from "./utils/embark";
import RootChain from "@omisego/omg-js-rootchain";
import { selectUtxos } from "./utils/plasma";
import { transaction } from "@omisego/omg-js-util";
import { waterfall } from "async";

// const WEB3_PROVIDER_URL = "https://rinkeby.infura.io/";
// const WATCHER_URL = "https://watcher.ari.omg.network/";
// const CHILDCHAIN_URL = "https://ari.omg.network/";
// const PLASMA_CONTRACT_ADDRESS = "0x44de0ec539b8c4a4b530c78620fe8320167f2f74";

// Service check constants
const SERVICE_CHECK_ON = 'on';
const SERVICE_CHECK_OFF = 'off';


// var web3 = new Web3()
let globalKeystore;
let rootChain;
let childChain;

// const ADDRESS = "0x1e8df8b7d4212084bf5329fddc730b9e5aaba238";
// const ADDRESS_PK = "0x0f7aa58edd2758334a819516b3421953b6c453c3e8ed85b071ce1edf3aedfab8";
const ACCOUNT_CONFIG_ERROR = "Blockchain accounts configuration is missing. To use the Embark-OMG plugin, you must configure blockchain accounts to use either a private key file, a private key, or a mnemonic.";
const ACCOUNT_BALANCE_ERROR = "The configured account does not have enough funds. Please make sure this account has Rinkeby ETH.";


/**
 * Plugin that connects an Embark dApp to the Status app, and allows the dApp
 * to be run in the Status browser.
 */
class EmbarkOmg {
  constructor(embark) {
    this.embark = embark;
    this.events = this.embark.events;
    this.pluginConfig = this.embark.pluginConfig;
    this.logger = this.embark.logger;
    this.fs = embark.fs;
    this.initing = false;
    this.inited = false;
    this.address = "";
    this.addressPrivateKey = "";
    this.maxDeposit = 0;


    // plugin opts
    this.plasmaContractAddress = this.pluginConfig.PLASMA_CONTRACT_ADDRESS;
    this.web3ProviderUrl = this.pluginConfig.WEB3_PROVIDER_URL;
    this.watcherUrl = this.pluginConfig.WATCHER_URL;
    this.childChainUrl = this.pluginConfig.CHILDCHAIN_URL;

    this.registerServiceCheck();
    this.registerConsoleCommands();

    // gets hydrated blockchain config from embark
    this.events.once('config:load:blockchain', (blockchainConfig) => {
      this.logger.info("blockchain config loaded...");
      this.embarkUtils = new EmbarkUtils({ events: this.events, logger: this.logger, blockchainConfig });

      this.init();
    });
  }

  async init() {
    try {
       if (this.initing) {
        const message = "Already intializing the Plasma chain, please wait...";
        this.logger.error(message);
        throw new Error(message);
      }
      this.initing = true;

      // init account used for root and child chains
      const accounts = await this.embarkUtils.accounts;
      if (!(accounts && accounts.length)) {
        this.logger.error(ACCOUNT_CONFIG_ERROR);
        throw new Error(ACCOUNT_CONFIG_ERROR);
      }
      const { address, privateKey } = accounts[0];
      this.address = address;
      this.addressPrivateKey = privateKey;


      // init Web3
      const Web3 = await this.embarkUtils.web3;
      this.web3 = new Web3();
      const web3Provider = new Web3.providers.HttpProvider(this.web3ProviderUrl);
      this.web3.setProvider(web3Provider);

      // check account balance on the main chain
      try {
        this.maxDeposit = await this.web3.eth.getBalance(this.address);
        if (!this.maxDeposit || new BigNumber(this.maxDeposit).lte(0)) {
          this.logger.error(ACCOUNT_BALANCE_ERROR);
          throw new Error(ACCOUNT_BALANCE_ERROR);
        }
        this.maxDeposit = new BigNumber(this.maxDeposit);
      }
      catch (e) {
        this.logger.error(`Error getting balance for account ${this.address}: ${e}`);
      }

      // set up the Plasma chain
      this.rootChain = new RootChain(this.web3, this.plasmaContractAddress);
      this.childChain = new ChildChain(this.watcherUrl, this.childChainUrl);

      // set lifecycle state vars
      this.initing = false;
      this.inited = true;
      this.events.emit("embark-omg:init");

      // await this.deposit();
      // await this.txChildChain();
    }
    catch (e) {
      const message = `Error initializing Plasma chain: ${e}`;
      this.logger.error(message);
      throw new Error(message);
    }
  }

  async deposit(amount) {
    if (!this.inited) {
      const message = "Please wait for the Plasma chain to initialize...";
      this.logger.error(message);
      throw new Error(message);
    }
    amount = new BigNumber(amount);
    if (!amount || amount.lte(0)) {
      const message = "You must deposit more than 0 wei.";
      this.logger.error(message);
      throw new Error(message);
    }
    if (amount.gt(this.maxDeposit)) {
      // recheck balance in case it was updated in a recent tx
      this.maxDeposit = await this.web3.eth.getBalance(this.address);
      if (amount.gt(this.maxDeposit)) {
        const message = `You do not have enough funds for this deposit. Please deposit more funds in to ${this.address} and then try again.`;
        this.logger.error(message);
        throw new Error(message);
      }
    }
    // const DEPOSIT_AMT = "100000";
    this.logger.info(`Depositing ${amount} wei...`);
    const depositTx = transaction.encodeDeposit(this.address, amount, transaction.ETH_CURRENCY);
    try {
      const receipt = await this.rootChain.depositEth(depositTx, amount, { from: this.address, privateKey: this.addressPrivateKey });
      this.logger.trace(receipt);
      const message = `Successfully deposited ${amount} wei in to the Plasma chain.\nView the transaction: https://rinkeby.etherscan.io/tx/${receipt.transactionHash}.`;
      this.logger.info(message);
      return message;
    }
    catch (e) {
      const message = `Error depositing ${amount} wei: ${e}`;
      this.logger.error(message);
      throw new Error(message);
    }
  }

  async txChildChain(toAddress, val) {
    //const val = "555";
    // const toAddress = "0x38d5beb778b6e62d82e3ba4633e08987e6d0f990";
    const utxos = await this.childChain.getUtxos(this.address);
    const utxosToSpend = selectUtxos(utxos, val, transaction.ETH_CURRENCY);
    if (!utxosToSpend) {
      return this.logger.error(`No utxo big enough to cover the amount ${val}`);
    }
    val = new BigNumber(val);
    if (!val || val.lte(0)) {
      return this.logger.error("Transaction value must be more than 0 wei.");
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

      const signatures = await this.childChain.signTransaction(unsignedTx, [this.addressPrivateKey]);

      const signedTx = await this.childChain.buildSignedTransaction(unsignedTx, signatures);

      const result = await this.childChain.submitTransaction(signedTx);

      const message = `Successfully submitted tx on the child chain: ${JSON.stringify(result)}\nView the transaction: http://quest.ari.omg.network/transaction/${result.txhash}`;

      this.logger.info(message);
      return message;
    }
    catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  registerConsoleCommands() {
    this.embark.registerConsoleCommand({
      description: `Initialises the Plasma chain using the account configured in the DApp's blockchain configuration. All transactions on the child chain will use this as the 'from' account.`,
      matches: ["plasma init", "plasma init --force"],
      usage: "plasma init [--force]",
      process: (cmd, callback) => {
        const force = cmd.endsWith("--force");
        if (this.inited && !force) {
          return callback("The Plasma chain is already initialized. If you'd like to reinitialize the chain, use the --force option ('plasma init --force')."); // passes a message back to cockpit console
        }
        this.init()
        .then((message) => {
          callback(null, message);
        })
        .catch(callback);
      }
    });

    const depositRegex = /^plasma[\s]+deposit[\s]+([0-9]+)$/;
    this.embark.registerConsoleCommand({
      description: "Deposits ETH from the root chain (Rinkeby) to the Plasma chain to be used for transacting on the Plasma chain.",
      matches: (cmd) => {
        return depositRegex.test(cmd);
      },
      usage: "plasma deposit [amount]",
      process: (cmd, callback) => {
        if (!this.inited) {
          return callback("The Plasma chain has not been initialized. Please initialize the Plamsa chain using 'plasma init' before continuting."); // passes a message back to cockpit console
        }
        const matches = cmd.match(depositRegex) || [];
        if (matches.length <= 1) {
          return callback("Invalid command format, please use the format 'plasma deposit [amount]', ie 'plasma deposit 100000'");
        }
        this.deposit(matches[1])
        .then((message) => {
          callback(null, message);
        })
        .catch(callback);
      }
    });

    const sendRegex = /^plasma[\s]+send[\s]+(0x[0-9,a-f,A-F]{40,40})[\s]+([0-9]+)$/;
    this.embark.registerConsoleCommand({
      description: "Sends an ETH tx on the Plasma chain from the account configured in the DApp's blockchain configuration to any other account on the Plasma chain.",
      matches: (cmd) => {
        return sendRegex.test(cmd);
      },
      usage: "plasma send [to_address] [amount]",
      process: (cmd, callback) => {
        if (!this.inited) {
          return callback("The Plasma chain has not been initialized. Please initialize the Plamsa chain using 'plasma init' before continuting."); // passes a message back to cockpit console
        }
        const matches = cmd.match(sendRegex) || [];
        if (matches.length <= 2) {
          return callback("Invalid command format, please use the format 'plasma send [to_address] [amount]', ie 'plasma send 0x38d5beb778b6e62d82e3ba4633e08987e6d0f990 555'");
        }
        this.txChildChain(matches[1], matches[2])
        .then((message) => {
          callback(null, message);
        })
        .catch(callback);
      }
    });
  }

  /**
   * Registers this plugin for Embark service checks and sets up log messages for
   * connection and disconnection events. The service check pings the Status app.
   * 
   * @returns {void}
   */
  registerServiceCheck() {
    const NO_NODE = "noNode";
    const name = "OMG Plasma Chain";

    this.events.request("services:register", name, (cb) => {

      waterfall([
        (next) => {
          if (this.inited) {
            return next();
          }
          this.events.once("embark-omg:init", next);
        },
        (next) => {
          // TODO: web3_clientVersion method is currently not implemented in web3.js 1.0
          this.web3._requestManager.send({ method: 'web3_clientVersion', params: [] }, (err, version) => {
            if (err || !version) {
              return next(null, { name: "Plasma chain not found", status: SERVICE_CHECK_OFF });
            }
            if (version.indexOf("/") < 0) {
              return next(null, { name: version, status: SERVICE_CHECK_ON });
            }
            let nodeName = version.split("/")[0];
            let versionNumber = version.split("/")[1].split("-")[0];
            let name = nodeName + " " + versionNumber + " (Plasma)";

            return next(null, { name: name, status: SERVICE_CHECK_ON });
          });
        }
      ], (err, statusObj) => {
        if (err && err !== NO_NODE) {
          return cb(err);
        }
        cb(statusObj);
      });
    }, 5000, 'off');

    this.embark.events.on('check:backOnline:OmiseGO', () => {
      this.logger.info("------------------");
      this.logger.info("Connected to the Plama chain!");
      this.logger.info("------------------");
    });

    this.embark.events.on('check:wentOffline:OmiseGO', () => {
      this.logger.error("------------------");
      this.logger.error("Couldn't connect or lost connection to the Plasma chain...");
      this.logger.error("------------------");
    });
  }
}

export default EmbarkOmg;
