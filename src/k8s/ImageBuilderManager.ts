import buildImageAndPush from './ImageBuilder';
import { v4 as uuidv4 } from 'uuid';
import DatabaseInterface from '../drivers/databases/DatabaseInterface';
import { KubepiterBuildJobLog } from '../types/common';
import { CoreV1Api } from '@kubernetes/client-node';
import { getKuberneteCore } from './getKubernete';
import getDatabaseConnection from '../drivers/databases/DatabaseInstance';

export interface ImageBuilderOptions {
  appId: string;
  git: {
    url: string;
    branch: string;
    username?: string;
    password?: string;
  };
  image: string;
  version: string;
  args: {
    name: string;
    value: string;
  }[];
  imagePullSecret?: string;
}

export enum ImageBuildJobStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

export interface ImageBuildJob extends KubepiterBuildJobLog {
  options: ImageBuilderOptions;
  callback?: (job: ImageBuildJob) => void;
}

export class ImageBuilderManager {
  protected queue: ImageBuildJob[] = [];
  protected app: Record<string, ImageBuildJob> = {};
  protected db: DatabaseInterface;
  protected k8CoreApi: CoreV1Api;

  constructor(coreApi: CoreV1Api, db: DatabaseInterface) {
    this.db = db;
    this.k8CoreApi = coreApi;
  }

  create(options: ImageBuilderOptions, callback?: (job: ImageBuildJob) => void) {
    const job: ImageBuildJob = {
      id: uuidv4(),
      appId: options.appId,
      version: options.version,
      createdAt: Math.floor(Date.now() / 1000),
      startAt: null,
      endAt: null,
      options,
      status: ImageBuildJobStatus.PENDING,
      logs: '',
      callback,
    };

    this.app[options.appId] = job;

    this.addLog(job).then(() => {
      this.queue.push(job);
      this.consume().then();
    });

    return job;
  }

  getLastJobFromAppId(appId: string) {
    return this.app[appId];
  }

  getQueue() {
    return this.queue.map((q) => {
      const { callback, ...rest } = q;
      return rest;
    });
  }

  protected async addLog(job: ImageBuildJob) {
    try {
      const { callback: _, options: __, ...rest } = job;
      await this.db.insertBuildLog(rest);
    } catch (e) {
      console.error(e);
    }
  }

  protected async updateLog(job: ImageBuildJob) {
    try {
      const { callback: _, options: __, ...rest } = job;
      await this.db.updateBuildLog(job.id, rest);
    } catch (e) {
      console.error(e);
    }
  }

  async consume() {
    if (this.queue.length > 0) {
      if (this.queue[0].status === ImageBuildJobStatus.PENDING) {
        this.queue[0].status = ImageBuildJobStatus.RUNNING;
        this.queue[0].startAt = Math.floor(Date.now() / 1000);

        await this.updateLog(this.queue[0]);

        const { logs, status } = await buildImageAndPush(this.k8CoreApi, this.db, this.queue[0].options, (newLog) => {
          this.queue[0].logs = newLog;
        });

        this.queue[0].endAt = Math.floor(Date.now() / 1000);
        this.queue[0].logs = logs;
        this.queue[0].status = status;

        if (this.queue[0].callback) {
          this.queue[0].callback(this.queue[0]);
        }

        await this.updateLog(this.queue[0]);

        this.queue.shift();
        this.consume().then();
      }
    }
  }
}

const singleBuildManager = new ImageBuilderManager(getKuberneteCore(), getDatabaseConnection());

export function getBuildManager() {
  return singleBuildManager;
}
