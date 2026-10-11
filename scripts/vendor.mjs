// 配布物に同梱するライブラリを node_modules から vendor/ にコピーする（pnpm install 時に自動実行）
import { copyFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'vendor');
const xlsx = realpathSync(join(root, 'node_modules/write-excel-file'));
const fflate = join(xlsx, '../fflate'); // write-excel-file のバンドルに含まれる圧縮ライブラリ

mkdirSync(out, { recursive: true });
copyFileSync(join(xlsx, 'bundle/write-excel-file.min.js'), join(out, 'write-excel-file.min.js'));
copyFileSync(join(xlsx, 'LICENSE'), join(out, 'write-excel-file.LICENSE.txt'));
copyFileSync(join(fflate, 'LICENSE'), join(out, 'fflate.LICENSE.txt'));
console.log('vendor/ を更新しました');
