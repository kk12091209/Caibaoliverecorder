import path from 'node:path';
import {buildSwiftHelper,projectRoot} from './build-swift-helper.mjs';

if(process.platform!=='darwin')throw new Error('此构建仅适用于 macOS；Windows 使用系统 DPAPI。');
const target=path.resolve(process.argv[2]||path.join(projectRoot,'.tools/runtime/credentials/cookie-protection'));
await buildSwiftHelper({target,name:'cookie-protection',source:'CookieProtection.swift',framework:'Security',
  temporaryPrefix:'caibao-cookie-helper-',temporaryEnvironment:{TMPDIR:'/private/tmp'},
  signIdentifier:'io.github.kk12091209.caibo.cookie-protection',successMessage:'Cookie 安全存储助手已生成。'});
