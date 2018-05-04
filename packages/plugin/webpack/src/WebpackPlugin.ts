import { asyncOra } from '@electron-forge/async-ora';
import PluginBase from '@electron-forge/plugin-base';
import Logger from '@electron-forge/web-multi-logger';
import Tab from '@electron-forge/web-multi-logger/dist/Tab';
import fs from 'fs-extra';
import merge from 'webpack-merge';
import path from 'path';
import { spawnPromise } from 'spawn-rx';
import webpack, { Configuration } from 'webpack';
import webpackHotMiddleware from 'webpack-hot-middleware';
import webpackDevMiddleware from 'webpack-dev-middleware';
import express from 'express';

import HtmlWebpackPlugin, { Config } from 'html-webpack-plugin';

import { WebpackPluginConfig, WebpackPluginEntryPoint } from './Config';

const BASE_PORT = 3000;

export default class WebpackPlugin extends PluginBase<WebpackPluginConfig> {
  name = 'webpack';
  private isProd = false;
  private baseDir!: string;

  constructor(c: WebpackPluginConfig) {
    super(c);

    this.startLogic = this.startLogic.bind(this);
    this.getHook = this.getHook.bind(this);
  }

  private resolveConfig = (config: Configuration | string) => {
    if (typeof config === 'string') return require(path.resolve(path.dirname(this.baseDir), config)) as Configuration;
    return config;
  }

  init = (dir: string) => {
    this.baseDir = path.resolve(dir, '.webpack');
  }

  getHook(name: string) {
    switch (name) {
      case 'prePackage':
        this.isProd = true;
        return async () => {
          await this.compileMain();
          await this.compileRenderers();
        };
    }
    return null;
  }

  getMainConfig = async () => {
    const mainConfig = this.resolveConfig(this.config.mainConfig);

    if (!mainConfig.entry) {
      throw new Error('Required config option "entry" has not been defined');
    }

    const defines: { [key: string]: string; } = {};
    let index = 0;
    if (!this.config.renderer.entryPoints || !Array.isArray(this.config.renderer.entryPoints)) {
      throw new Error('Required config option "renderer.entryPoints" has not been defined');
    }
    for (const entryPoint of this.config.renderer.entryPoints) {
      defines[`${entryPoint.name.toUpperCase().replace(/ /g, '_')}_WEBPACK_ENTRY`] =
        this.isProd
        ? `\`file://\$\{require('path').resolve(__dirname, '../renderer', '${entryPoint.name}', 'index.html')\}\``
        : `'http://localhost:${BASE_PORT + index}'`;
      index += 1;
    }
    return merge.smart({
      devtool: 'source-map',
      target: 'electron-main',
      output: {
        path: path.resolve(this.baseDir, 'main'),
        filename: 'index.js',
        libraryTarget: 'commonjs2',
      },
      plugins: [
        new webpack.DefinePlugin(defines),
      ],
      node: {
        __dirname: false,
        __filename: false,
      },
      resolve: {
        modules: [
          path.resolve(path.dirname(this.baseDir), './'),
          path.resolve(path.dirname(this.baseDir), 'node_modules'),
          path.resolve(__dirname, '..', 'node_modules'),
        ],
      },
    }, mainConfig || {});
  }

  getRendererConfig = async (entryPoint: WebpackPluginEntryPoint) => {
    const rendererConfig = this.resolveConfig(this.config.renderer.config);
    const prefixedEntries = this.config.renderer.prefixedEntries || [];
    return merge.smart({
      devtool: 'inline-source-map',
      target: 'electron-renderer',
      entry: prefixedEntries.concat([
        entryPoint.js,
      ]).concat(this.isProd ? [] : ['webpack-hot-middleware/client']),
      output: {
        path: path.resolve(this.baseDir, 'renderer', entryPoint.name),
        filename: 'index.js',
      },
      node: {
        __dirname: false,
        __filename: false,
      },
      plugins: [
        new HtmlWebpackPlugin({
          title: entryPoint.name,
          template: entryPoint.html,
        }),
      ].concat(this.isProd ? [] : [new webpack.HotModuleReplacementPlugin()]),
    }, rendererConfig);
  }

  compileMain = async (logger?: Logger) => {
    let tab: Tab;
    if (logger) {
      tab = logger.createTab('Main Process');
    }
    await asyncOra('Compiling Main Process Code', async () => {
      await new Promise(async (resolve, reject) => {
        webpack(await this.getMainConfig()).run((err, stats) => {
          if (tab) {
            tab.log(stats.toString({
              colors: true,
            }));
          }

          if (err) return reject(err);
          resolve();
        });
      });
    });
  }

  compileRenderers = async () => {
    for (const entryPoint of this.config.renderer.entryPoints) {
      await asyncOra(`Compiling Renderer Template: ${entryPoint.name}`, async () => {
        await new Promise(async (resolve, reject) => {
          webpack(await this.getRendererConfig(entryPoint)).run((err, stats) => {
            if (err) return reject(err);
            resolve();
          });
        });
      });
    }
  }

  launchDevServers = async (logger: Logger) => {
    await asyncOra('Launch Dev Servers', async () => {
      let index = 0;
      for (const entryPoint of this.config.renderer.entryPoints) {
        const tab = logger.createTab(entryPoint.name);

        const config = await this.getRendererConfig(entryPoint);
        const compiler = webpack(config);
        const server = webpackDevMiddleware(compiler, {
          logger: {
            log: tab.log.bind(tab),
            info: tab.log.bind(tab),
            error: tab.log.bind(tab),
            warn: tab.log.bind(tab),
          },
          publicPath: '/',
          hot: true,
          historyApiFallback: true,
        } as any);
        const app = express();
        app.use(server);
        app.use(webpackHotMiddleware(compiler));
        app.listen(BASE_PORT + index);
        index += 1;
      }
    });
  }

  async startLogic(): Promise<false> {
    const logger = new Logger();
    await this.compileMain(logger);
    await this.launchDevServers(logger);
    await logger.start();
    return false;
  }
}
