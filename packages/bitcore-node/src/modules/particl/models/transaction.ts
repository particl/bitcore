import logger from '../../../logger';
import * as lodash from 'lodash';
import crypto from "crypto";

import { CoinStorage } from '../../../models/coin';
import { WalletAddressStorage, IWalletAddress } from '../../../models/walletAddress';
import { partition } from '../../../utils/partition';
import { ObjectID } from 'bson';
import { TransformOptions } from '../../../types/TransformOptions';
import { LoggifyClass } from '../../../decorators/Loggify';
import { Particl } from '../../../types/namespaces/Particl';
import { MongoBound } from '../../../models/base';
import { StorageService } from '../../../services/storage';
import { TransactionJSON } from '../../../types/Transaction';
import { SpentHeightIndicators } from '../../../types/Coin';
import { Config } from '../../../services/config';
import { EventStorage } from '../../../models/events';
import { Libs } from '../../../providers/libs';
import { BaseTransaction, ITransaction } from '../../../models/baseTransaction';
export { ITransaction };

const { onlyWalletEvents } = Config.get().services.event;
function shouldFire(obj: { wallets?: Array<ObjectID> }) {
  return !onlyWalletEvents || (onlyWalletEvents && obj.wallets && obj.wallets.length > 0);
}

export type IPartTransaction = ITransaction & {
  coinbase: boolean;
  coinstake?: boolean;
  locktime: number;
  inputCount: number;
  outputCount: number;
  size: number;
};

export type MintOp = {
  updateOne: {
    filter: {
      mintTxid: string;
      mintIndex: number;
      chain: string;
      network: string;
    };
    update: {
      $set: {
        chain: string;
        network: string;
        address: string;
        mintHeight: number;
        coinbase: boolean;
        value: number;
        script: Buffer;
        spentTxid?: string;
        spentHeight?: SpentHeightIndicators;
        wallets?: Array<ObjectID>;
        witnesses?: string[];
        type?: number;
        data?: Buffer;
        pubkey?: Buffer;
        valueCommitment?: Buffer;
        rangeproof?: Buffer;
        coinstake?: boolean
      };
      $setOnInsert: {
        spentHeight: SpentHeightIndicators;
        wallets: Array<ObjectID>;
      };
    };
    upsert: true;
    forceServerObjectId: true;
  };
};

export type SpendOp = {
  updateOne: {
    filter: {
      mintTxid: string;
      mintIndex: number;
      spentHeight: { $lt: SpentHeightIndicators };
      chain: string;
      network: string;
    };
    update: { $set: { spentTxid: string; spentHeight: number; witnesses: string[]; } };
  };
};

@LoggifyClass
export class ParticlTransactionModel extends BaseTransaction<IPartTransaction> {
  constructor(storage?: StorageService) {
    super(storage);
  }

  async batchImport(params: {
    txs: Array<Particl.Transaction>;
    height: number;
    mempoolTime?: Date;
    blockTime?: Date;
    blockHash?: string;
    blockTimeNormalized?: Date;
    parentChain?: string;
    forkHeight?: number;
    chain: string;
    network: string;
    initialSyncComplete: boolean;
  }) {
    const { initialSyncComplete, height } = params;
    const mintOps = await this.getMintOps(params);
    const spendOps = this.getSpendOps({ ...params, mintOps });

    const getUpdatedBatchIfMempool = batch =>
      height >= SpentHeightIndicators.minimum ? batch : batch.map(op => this.toMempoolSafeUpsert(op, height));

    await this.pruneMempool({
      chain: params.chain,
      network: params.network,
      initialSyncComplete,
      spendOps
    });

    logger.debug('Minting Coins', mintOps.length);
    if (mintOps.length) {
      await Promise.all(
        partition(mintOps, mintOps.length / Config.get().maxPoolSize).map(async mintBatch => {
          await CoinStorage.collection.bulkWrite(getUpdatedBatchIfMempool(mintBatch), { ordered: false });
          if (params.height < SpentHeightIndicators.minimum) {
            EventStorage.signalAddressCoins(
              mintBatch
                .map(coinOp => {
                  const address = coinOp.updateOne.update.$set.address;
                  const coin = { ...coinOp.updateOne.update.$set, ...coinOp.updateOne.filter };
                  return { address, coin };
                })
                .filter(({ coin }) => shouldFire(coin))
            );
          }
        })
      );
    }

    logger.debug('Spending Coins', spendOps.length);
    if (spendOps.length) {
      await Promise.all(
        partition(spendOps, spendOps.length / Config.get().maxPoolSize).map(spendBatch =>
          CoinStorage.collection.bulkWrite(spendBatch, { ordered: false })
        )
      );
    }

    if (mintOps) {
      const txOps = await this.addTransactions({ ...params, mintOps });
      logger.debug('Writing Transactions', txOps.length);
      await Promise.all(
        partition(txOps, txOps.length / Config.get().maxPoolSize).map(async txBatch => {
          await this.collection.bulkWrite(getUpdatedBatchIfMempool(txBatch), { ordered: false });
          if (params.height < SpentHeightIndicators.minimum) {
            EventStorage.signalTxs(
              txBatch.map(op => ({ ...op.updateOne.update.$set, ...op.updateOne.filter })).filter(shouldFire)
            );
          }
        })
      );
    }
  }

  async addTransactions(params: {
    txs: Array<Particl.Transaction>;
    height: number;
    blockTime?: Date;
    blockHash?: string;
    blockTimeNormalized?: Date;
    parentChain?: string;
    forkHeight?: number;
    initialSyncComplete: boolean;
    chain: string;
    network: string;
    mintOps: Array<MintOp>;
    mempoolTime?: Date;
  }) {
    let {
      blockHash,
      blockTime,
      blockTimeNormalized,
      chain,
      height,
      network,
      parentChain,
      forkHeight,
      mempoolTime
    } = params;
    if (parentChain && forkHeight && height < forkHeight) {
      const parentTxs = await ParticlTransactionStorage.collection
        .find({ blockHeight: height, chain: parentChain, network })
        .toArray();
      return parentTxs.map(parentTx => {
        return {
          updateOne: {
            filter: { txid: parentTx.txid, chain, network },
            update: {
              $set: {
                chain,
                network,
                blockHeight: height,
                blockHash,
                blockTime,
                blockTimeNormalized,
                coinbase: parentTx.coinbase,
                coinstake: parentTx.coinstake,
                fee: parentTx.fee,
                size: parentTx.size,
                locktime: parentTx.locktime,
                inputCount: parentTx.inputCount,
                outputCount: parentTx.outputCount,
                value: parentTx.value,
                wallets: [],
                ...(mempoolTime && { mempoolTime })
              }
            },
            upsert: true,
            forceServerObjectId: true
          }
        };
      });
    } else {
      let spentQuery;
      if (height > 0) {
        spentQuery = { spentHeight: height, chain, network };
      } else {
        spentQuery = { spentTxid: { $in: params.txs.map(tx => tx._hash) }, chain, network };
      }
      const spent = await CoinStorage.collection
        .find(spentQuery)
        .project({ spentTxid: 1, value: 1, wallets: 1 })
        .toArray();
      type CoinGroup = { [txid: string]: { total: number; wallets: Array<ObjectID> } };
      const groupedMints = params.mintOps.reduce<CoinGroup>((agg, coinOp) => {
        const mintTxid = coinOp.updateOne.filter.mintTxid;
        const coin = coinOp.updateOne.update.$set;
        const { value, wallets = [] } = coin;
        if (!agg[mintTxid]) {
          agg[mintTxid] = {
            total: value,
            wallets: wallets ? [...wallets] : []
          };
        } else {
          agg[mintTxid].total += value;
          agg[mintTxid].wallets.push(...wallets);
        }
        return agg;
      }, {});

      const groupedSpends = spent.reduce<CoinGroup>((agg, coin) => {
        if (!agg[coin.spentTxid]) {
          agg[coin.spentTxid] = {
            total: coin.value,
            wallets: coin.wallets ? [...coin.wallets] : []
          };
        } else {
          agg[coin.spentTxid].total += coin.value;
          agg[coin.spentTxid].wallets.push(...coin.wallets);
        }
        return agg;
      }, {});

      let txOps: any[] = params.txs.map(tx => {
        const txid = tx._hash!;
        const minted = groupedMints[txid] || {};
        const spent = groupedSpends[txid] || {};
        const mintedWallets = minted.wallets || [];
        const spentWallets = spent.wallets || [];
        const txWallets = mintedWallets.concat(spentWallets);
        const wallets = lodash.uniqBy(txWallets, wallet => wallet.toHexString());
        let fee = 0;
        if (groupedMints[txid] && groupedSpends[txid]) {
          // TODO: Fee is negative for mempool txs
          fee = groupedSpends[txid].total - groupedMints[txid].total;
          if (fee < 0) {
            logger.debug('negative fee', txid, groupedSpends[txid], groupedMints[txid]);
          }
        }

        return {
          updateOne: {
            filter: { txid, chain, network },
            update: {
              $set: {
                chain,
                network,
                blockHeight: height,
                blockHash,
                blockTime,
                blockTimeNormalized,
                coinbase: tx.isCoinbase(),
                coinstake: tx.isCoinStake(),
                fee,
                size: tx.toBuffer().length,
                locktime: tx.nLockTime,
                inputCount: tx.inputs.length,
                outputCount: tx.outputs.length,
                value: tx.outputAmount,
                wallets,
                ...(mempoolTime && { mempoolTime })
              }
            },
            upsert: true,
            forceServerObjectId: true
          }
        };
      });
      return txOps;
    }
  }

  async getMintOps(params: {
    txs: Array<Particl.Transaction>;
    height: number;
    parentChain?: string;
    forkHeight?: number;
    initialSyncComplete: boolean;
    chain: string;
    network: string;
    mintOps?: Array<MintOp>;
  }) {
    let { chain, height, network, parentChain, forkHeight, initialSyncComplete } = params;
    let mintOps = new Array<MintOp>();
    let parentChainCoinsMap = new Map();
    if (parentChain && forkHeight && height < forkHeight) {
      let parentChainCoins = await CoinStorage.collection
        .find({
          chain: parentChain,
          network,
          mintHeight: height,
          $or: [{ spentHeight: { $lt: SpentHeightIndicators.minimum } }, { spentHeight: { $gte: forkHeight } }]
        })
        .project({ mintTxid: 1, mintIndex: 1 })
        .toArray();
      for (const parentChainCoin of parentChainCoins) {
        parentChainCoinsMap.set(`${parentChainCoin.mintTxid}:${parentChainCoin.mintIndex}`, true);
      }
    }
    for (let tx of params.txs) {
      tx._hash = tx.hash;
      let isCoinbase = tx.isCoinbase();
      let isCoinStake = tx.isCoinStake();
      for (let [index, output] of tx.outputs.entries()) {
        if (
          parentChain &&
          forkHeight &&
          height < forkHeight &&
          (!parentChainCoinsMap.size || !parentChainCoinsMap.get(`${tx._hash}:${index}`))
        ) {
          continue;
        }
        let address = '';
        if (output.script) {
          address = output.script.toAddress(network).toString(true);
          if (address === 'false' && output.script.classify() === 'Pay to public key') {
            let hash = Libs.get(chain).lib.crypto.Hash.sha256ripemd160(output.script.chunks[0].buf);
            address = Libs.get(chain)
              .lib.Address(hash, network)
              .toString(true);
          }
        }
        // Anon
        if (output.type === 3) {
          const pk = Libs.get(chain).lib.PublicKey(output.pubkey);
          address = Libs.get(chain).lib.Address.fromPublicKey(pk, network).toString();
        }
        mintOps.push({
          updateOne: {
            filter: {
              mintTxid: tx._hash,
              mintIndex: index,
              chain,
              network
            },
            update: {
              $set: {
                chain,
                network,
                address,
                mintHeight: height,
                coinbase: isCoinbase,
                value: output.satoshis,
                script: output.script && output.script.toBuffer(),
                type: output.type,
                data: output.data,
                pubkey: output.pubkey,
                valueCommitment: output.valueCommitment,
                rangeproof: output.rangeproof,
                coinstake: isCoinStake
              },
              $setOnInsert: {
                spentHeight: SpentHeightIndicators.unspent,
                wallets: []
              }
            },
            upsert: true,
            forceServerObjectId: true
          }
        });
      }

      // If there is an Anon input we need to "mint" it as there will be no prev tx for it <shrugs>
      for (const input of tx.inputs) {
        const inputObj = input.toObject();
        
        if (inputObj.outputIndex === 0xffffffa0) {
          const id = crypto.randomBytes(16).toString('hex');
          const anonTxId = `${inputObj.prevTxId}_${id}`; // hhhmmmmm
          let address, value, script;
          mintOps.push({
            updateOne: {
              filter: {
                mintTxid: anonTxId, 
                mintIndex: inputObj.outputIndex,
                chain,
                network
              },
              update: {
                $set: {
                  chain,
                  network,
                  address,
                  mintHeight: height,
                  coinbase: false,
                  type: 3,
                  data: Buffer.from(inputObj.data || '', 'hex'),
                  spentTxid: tx._hash,
                  value,
                  script,
                  witnesses: inputObj.witnesses
                },
                $setOnInsert: {
                  spentHeight: height,
                  wallets: []
                }
              },
              upsert: true,
              forceServerObjectId: true
            }
          });
        }
      }
    }

    const walletConfig = Config.for('api').wallets;
    if (initialSyncComplete || (walletConfig && walletConfig.allowCreationBeforeCompleteSync)) {
      let mintOpsAddressesSet = {};
      for (const mintOp of mintOps) {
        mintOpsAddressesSet[mintOp.updateOne.update.$set.address] = true;
      }
      let mintOpsAddresses = Object.keys(mintOpsAddressesSet);

      let wallets: IWalletAddress[] = [];

      await Promise.all(
        partition(mintOpsAddresses, mintOpsAddresses.length / Config.get().maxPoolSize).map(async addressesBatch => {
          let partialWallets = await WalletAddressStorage.collection
            .find({ address: { $in: addressesBatch }, chain, network }, { batchSize: 100 })
            .project({ wallet: 1, address: 1 })
            .toArray();

          wallets = wallets.concat(partialWallets);
        })
      );

      if (wallets.length) {
        mintOps = mintOps.map(mintOp => {
          let transformedWallets = wallets
            .filter(wallet => wallet.address === mintOp.updateOne.update.$set.address)
            .map(wallet => wallet.wallet);
          mintOp.updateOne.update.$set.wallets = transformedWallets;
          delete mintOp.updateOne.update.$setOnInsert.wallets;
          if (!Object.keys(mintOp.updateOne.update.$setOnInsert).length) {
            delete mintOp.updateOne.update.$setOnInsert;
          }
          return mintOp;
        });
      }
    }

    return mintOps;
  }

  getSpendOps(params: {
    txs: Array<Particl.Transaction>;
    height: number;
    parentChain?: string;
    forkHeight?: number;
    chain: string;
    network: string;
    mintOps?: Array<MintOp>;
    [rest: string]: any;
  }) {
    let { chain, network, height, parentChain, forkHeight } = params;
    let spendOps: SpendOp[] = [];
    if (parentChain && forkHeight && height < forkHeight) {
      return spendOps;
    }
    let mintMap = {} as Mapping<Mapping<MintOp>>;
    for (let mintOp of params.mintOps || []) {
      mintMap[mintOp.updateOne.filter.mintTxid] = mintMap[mintOp.updateOne.filter.mintIndex] || {};
      mintMap[mintOp.updateOne.filter.mintTxid][mintOp.updateOne.filter.mintIndex] = mintOp;
    }
    for (let tx of params.txs) {
      if (tx.isCoinbase()) {
        continue;
      }
      for (let input of tx.inputs) {
        let inputObj = input.toObject();
        let sameBlockSpend = mintMap[inputObj.prevTxId] && mintMap[inputObj.prevTxId][inputObj.outputIndex];
        if (sameBlockSpend) {
          sameBlockSpend.updateOne.update.$set.spentHeight = height;
          delete sameBlockSpend.updateOne.update.$setOnInsert.spentHeight;
          if (!Object.keys(sameBlockSpend.updateOne.update.$setOnInsert).length) {
            delete sameBlockSpend.updateOne.update.$setOnInsert;
          }
          sameBlockSpend.updateOne.update.$set.spentTxid = tx._hash;
          sameBlockSpend.updateOne.update.$set.witnesses = inputObj.witnesses;
          continue;
        }

        const updateQuery = {
          updateOne: {
            filter: {
              mintTxid: inputObj.prevTxId,
              mintIndex: inputObj.outputIndex,
              spentHeight: { $lt: SpentHeightIndicators.minimum },
              chain,
              network
            },
            update: { $set: { 
              spentTxid: tx._hash || tx.hash,
              spentHeight: height,
              witnesses: inputObj.witnesses
            } }
          }
        };
        spendOps.push(updateQuery);
      }
    }
    return spendOps;
  }

  async pruneMempool(params: {
    chain: string;
    network: string;
    spendOps: Array<SpendOp>;
    initialSyncComplete: boolean;
  }) {
    const { chain, network, spendOps, initialSyncComplete } = params;
    if (!initialSyncComplete || !spendOps.length) {
      return;
    }
    let coins = await CoinStorage.collection
      .find({
        chain,
        network,
        spentHeight: SpentHeightIndicators.pending,
        mintTxid: { $in: spendOps.map(s => s.updateOne.filter.mintTxid) }
      })
      .project({ mintTxid: 1, mintIndex: 1, spentTxid: 1 })
      .toArray();
    coins = coins.filter(
      c =>
        spendOps.findIndex(
          s =>
            s.updateOne.filter.mintTxid === c.mintTxid &&
            s.updateOne.filter.mintIndex === c.mintIndex &&
            s.updateOne.update.$set.spentTxid !== c.spentTxid
        ) > -1
    );

    const invalidatedTxids = Array.from(new Set(coins.map(c => c.spentTxid)));

    await Promise.all([
      this.collection.update(
        { chain, network, txid: { $in: invalidatedTxids } },
        { $set: { blockHeight: SpentHeightIndicators.conflicting } },
        { multi: true }
      ),
      CoinStorage.collection.update(
        { chain, network, mintTxid: { $in: invalidatedTxids } },
        { $set: { mintHeight: SpentHeightIndicators.conflicting } },
        { multi: true }
      )
    ]);

    return;
  }

  _apiTransform(tx: Partial<MongoBound<IPartTransaction>>, options?: TransformOptions): TransactionJSON | string {
    const transaction: TransactionJSON = {
      _id: tx._id ? tx._id.toString() : '',
      txid: tx.txid || '',
      network: tx.network || '',
      chain: tx.chain || '',
      blockHeight: tx.blockHeight || -1,
      blockHash: tx.blockHash || '',
      blockTime: tx.blockTime ? tx.blockTime.toISOString() : '',
      blockTimeNormalized: tx.blockTimeNormalized ? tx.blockTimeNormalized.toISOString() : '',
      coinbase: tx.coinbase || false,
      locktime: tx.locktime || -1,
      inputCount: tx.inputCount || -1,
      outputCount: tx.outputCount || -1,
      size: tx.size || -1,
      fee: tx.fee || -1,
      value: tx.value || -1
    };
    if (options && options.object) {
      return transaction;
    }
    return JSON.stringify(transaction);
  }
}
export let ParticlTransactionStorage = new ParticlTransactionModel();
