import path from 'node:path';
import {buildSwiftHelper,projectRoot} from './build-swift-helper.mjs';

if(process.platform!=='darwin')throw new Error('系统资源助手仅适用于 macOS。');
const target=path.resolve(process.argv[2]||path.join(projectRoot,'.tools/runtime/resources/live-system-resources'));
await buildSwiftHelper({target,name:'live-system-resources',source:'LiveSystemResources.swift',framework:'IOKit',
  temporaryPrefix:'caibao-live-resources-',temporaryEnvironment:{TMPDIR:'/private/tmp',TMP:'/private/tmp',TEMP:'/private/tmp'},
  createTargetDirectoryBeforeBuild:true,successMessage:`系统资源助手已生成：${target}`});
