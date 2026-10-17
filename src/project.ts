import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Linked worktrees share a verified main checkout; submodules remain separate. */
export function projectPath(input: string): string {
  const cwd = realpathSync(resolve(input));
  if (!statSync(cwd).isDirectory()) throw new Error('Workspace must be a directory');
  const env = { ...process.env };
  for (const key of ['GIT_DIR','GIT_WORK_TREE','GIT_COMMON_DIR','GIT_INDEX_FILE','GIT_CEILING_DIRECTORIES']) delete env[key];
  const git = (args: string[]) => execFileSync('git',['-C',cwd,...args],{
    encoding: 'utf8',timeout: 5000,stdio: ['ignore','pipe','ignore'],env,
  }).replace(/\r?\n$/u,'');
  try {
    if (git(['rev-parse','--is-bare-repository']) === 'true') {
      return realpathSync(git(['rev-parse','--path-format=absolute','--git-common-dir']));
    }
    const root = realpathSync(git(['rev-parse','--show-toplevel']));
    const relativePath = relative(root,cwd);
    if (isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${sep}`)) throw new Error('Invalid Git root');
    const common = realpathSync(git(['rev-parse','--path-format=absolute','--git-common-dir']));
    const records = git(['worktree','list','--porcelain','-z']).split('\0\0').filter(Boolean).map(record => record.split('\0'));
    const paths = records.map(record => {
      const field = record[0];
      if (!field?.startsWith('worktree ') || !isAbsolute(field.slice(9))) throw new Error('Invalid worktree record');
      return field.slice(9);
    });
    if (!paths[0]) throw new Error('Missing main worktree');
    if (records[0]!.includes('bare')) return common;
    let main = realpathSync(paths[0]);
    if (!existsSync(join(main,'.git'))) {
      // Submodules and separate-git-dir layouts report metadata as the main path.
      const backlink = git(['--git-dir',common,'config','--local','--get','core.worktree']);
      if (!backlink) throw new Error('Missing main-checkout backlink');
      main = realpathSync(resolve(common,backlink));
      const verified = execFileSync('git',['-C',main,'rev-parse','--path-format=absolute','--git-common-dir'],{
        encoding: 'utf8',timeout: 5000,stdio: ['ignore','pipe','ignore'],env,
      }).replace(/\r?\n$/u,'');
      if (realpathSync(verified) !== common) throw new Error('Invalid main-checkout backlink');
      paths[0] = main;
    }
    if (!paths.some(path => { try { return realpathSync(path) === root; } catch { return false; } })) {
      throw new Error('Current checkout is not a registered worktree');
    }
    return main;
  } catch {
    for (let directory = cwd;;directory = dirname(directory)) {
      if (existsSync(join(directory,'.git'))) throw new Error('Cannot verify Git project identity; fix the repository or choose another workspace');
      if (dirname(directory) === directory) return cwd;
    }
  }
}
