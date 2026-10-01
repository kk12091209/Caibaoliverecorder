import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep repeated local builds small even if a previous output survives Vite's
// directory cleanup. Remove only generated bundles inside this project's dist.
const outputRoot=fileURLToPath(new URL('./dist',import.meta.url));
const pruneOldBundles={
  name:'prune-old-local-bundles',apply:'build',
  writeBundle(output,bundle){
    if(!output.dir||path.resolve(output.dir)!==path.resolve(outputRoot))return;
    const assets=path.join(outputRoot,'assets');
    if(!fs.existsSync(assets))return;
    if(fs.lstatSync(outputRoot).isSymbolicLink()||fs.lstatSync(assets).isSymbolicLink())throw new Error('构建目录不能是链接。');
    for(const entry of fs.readdirSync(assets,{withFileTypes:true})){
      if(entry.isFile()&&/^index-[a-zA-Z0-9_-]+\.(?:js|css)$/.test(entry.name)&&!Object.hasOwn(bundle,'assets/'+entry.name))
        fs.unlinkSync(path.join(assets,entry.name));
    }
  },
};
export default defineConfig({
  plugins: [vue(),pruneOldBundles],
  build: { emptyOutDir: true },
});
