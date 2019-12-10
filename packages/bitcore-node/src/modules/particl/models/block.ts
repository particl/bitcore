import logger from '../../../logger';
import { CoinStorage } from '../../../models/coin';
import { ParticlTransactionStorage } from './transaction';
import { TransformOptions } from '../../../types/TransformOptions';
import { LoggifyClass } from '../../../decorators/Loggify';
import { Particl } from '../../../types/namespaces/Particl';
import { MongoBound } from '../../../models/base';
import { SpentHeightIndicators } from '../../../types/Coin';
import { EventStorage } from '../../../models/events';
import { StorageService } from '../../../services/storage';
import { BaseBlock, IBlock } from '../../../models/baseBlock';

export type IPartBlock = IBlock & {
  version: number;
  merkleRoot: string;
  witnessMerkleRoot: string;
  bits: number;
  nonce: number;
  difficulty: number;
};

@LoggifyClass
export class ParticlBlock extends BaseBlock<IPartBlock> {
  constructor(storage?: StorageService) {
    super(storage);
  }

  async addBlock(params: {
    block: Particl.Block;
    parentChain?: string;
    forkHeight?: number;
    initialSyncComplete: boolean;
    chain: string;
    network: string;
  }) {
    const { block, chain, network } = params;
    const header = block.header.toObject();

    const reorg = await this.handleReorg({ header, chain, network });

    if (reorg) {
      return Promise.reject('reorg');
    }
    return this.processBlock(params);
  }

  async processBlock(params: {
    block: Particl.Block;
    parentChain?: string;
    forkHeight?: number;
    initialSyncComplete: boolean;
    chain: string;
    network: string;
  }) {
    const { chain, network, block, parentChain, forkHeight, initialSyncComplete } = params;
    const blockOp = await this.getBlockOp(params);
    const convertedBlock = blockOp.updateOne.update.$set;
    const { height, timeNormalized, time } = convertedBlock;

    const previousBlock = await this.collection.findOne({ hash: convertedBlock.previousBlockHash, chain, network });

    await this.collection.bulkWrite([blockOp]);
    if (previousBlock) {
      await this.collection.updateOne(
        { chain, network, hash: previousBlock.hash },
        { $set: { nextBlockHash: convertedBlock.hash } }
      );
      logger.debug('Updating previous block.nextBlockHash ', convertedBlock.hash);
    }

    await ParticlTransactionStorage.batchImport({
      txs: block.transactions,
      blockHash: convertedBlock.hash,
      blockTime: new Date(time),
      blockTimeNormalized: new Date(timeNormalized),
      height: height,
      chain,
      network,
      parentChain,
      forkHeight,
      initialSyncComplete
    });

    if (initialSyncComplete) {
      EventStorage.signalBlock(convertedBlock);
    }

    // Rework out reward
    const inputs = await CoinStorage.collection.find({chain, network, spentTxid: block.transactions[0].hash})
      .addCursorFlag('noCursorTimeout', true)
      .toArray();
    const firstInputValue = inputs.length > 0 ? inputs[0].value : 0;

    await this.collection.updateOne(
      { hash: convertedBlock.hash, chain, network }, 
      { $set: { 
        processed: true,
        reward: convertedBlock.reward - firstInputValue
      }}
    );
    this.updateCachedChainTip({ block: convertedBlock, chain, network });
  }

  async getBlockOp(params: { block: Particl.Block; chain: string; network: string }) {
    const { block, chain, network } = params;
    const header = block.header.toObject();
    const blockTime = header.time * 1000;

    const previousBlock = await this.collection.findOne({ hash: header.prevHash, chain, network });

    const blockTimeNormalized = (() => {
      const prevTime = previousBlock ? previousBlock.timeNormalized : null;
      if (prevTime && blockTime <= prevTime.getTime()) {
        return prevTime.getTime() + 1;
      } else {
        return blockTime;
      }
    })();

    const height = (previousBlock && previousBlock.height + 1) || 1;
    logger.debug('Setting blockheight', height);

    const convertedBlock: IPartBlock = {
      chain,
      network,
      hash: block.hash,
      height,
      version: header.version,
      nextBlockHash: '',
      previousBlockHash: header.prevHash,
      merkleRoot: header.merkleRoot,
      witnessMerkleRoot: header.witnessMerkleRoot,
      difficulty: block.header.getDifficulty(),
      time: new Date(blockTime),
      timeNormalized: new Date(blockTimeNormalized),
      bits: header.bits,
      nonce: header.nonce,
      transactionCount: block.transactions.length,
      size: block.toBuffer().length,
      reward: block.transactions[0].outputAmount,
      processed: false
    };
    return {
      updateOne: {
        filter: {
          hash: header.hash,
          chain,
          network
        },
        update: {
          $set: convertedBlock
        },
        upsert: true
      }
    };
  }

  async handleReorg(params: { header?: Particl.Block.HeaderObj; chain: string; network: string }): Promise<boolean> {
    const { header, chain, network } = params;
    let localTip = await this.getLocalTip(params);
    if (header && localTip && localTip.hash === header.prevHash) {
      return false;
    }
    if (!localTip || localTip.height === 0) {
      return false;
    }
    if (header) {
      const prevBlock = await this.collection.findOne({ chain, network, hash: header.prevHash });
      if (prevBlock) {
        localTip = prevBlock;
        this.updateCachedChainTip({ chain, network, block: prevBlock });
      } else {
        delete this.chainTips[chain][network];
        logger.error(`Previous block isn't in the DB need to roll back until we have a block in common`);
      }
      logger.info(`Resetting tip to ${localTip.height - 1}`, { chain, network });
    }
    const reorgOps = [
      this.collection.deleteMany({ chain, network, height: { $gte: localTip.height } }),
      ParticlTransactionStorage.collection.deleteMany({ chain, network, blockHeight: { $gte: localTip.height } }),
      CoinStorage.collection.deleteMany({ chain, network, mintHeight: { $gte: localTip.height } })
    ];
    await Promise.all(reorgOps);

    await CoinStorage.collection.updateMany(
      { chain, network, spentHeight: { $gte: localTip.height } },
      { $set: { spentTxid: null, spentHeight: SpentHeightIndicators.unspent } }
    );

    logger.debug('Removed data from above blockHeight: ', localTip.height);
    return true;
  }

  _apiTransform(block: Partial<MongoBound<IPartBlock>>, options?: TransformOptions): any {
    const transform = {
      _id: block._id,
      chain: block.chain,
      network: block.network,
      hash: block.hash,
      height: block.height,
      version: block.version,
      size: block.size,
      merkleRoot: block.merkleRoot,
      witnessMerkleRoot: block.witnessMerkleRoot,
      difficulty: block.difficulty,
      time: block.time,
      timeNormalized: block.timeNormalized,
      nonce: block.nonce,
      bits: block.bits,
      /*
       *difficulty: block.difficulty,
       */
      /*
       *chainWork: block.chainWork,
       */
      previousBlockHash: block.previousBlockHash,
      nextBlockHash: block.nextBlockHash,
      reward: block.reward,
      /*
       *isMainChain: block.mainChain,
       */
      transactionCount: block.transactionCount
      /*
       *minedBy: BlockModel.getPoolInfo(block.minedBy)
       */
    };
    if (options && options.object) {
      return transform;
    }
    return JSON.stringify(transform);
  }
}

export let ParticlBlockStorage = new ParticlBlock();