/**
 * Daily upstream sync for the workspace folders fork, run by
 * `.github/workflows/folders-sync.yml` on a full clone of `main`.
 *
 * 1. Mirror upstream master to this repository's `master`.
 * 2. Merge upstream master into `main`: each first-parent upstream commit
 *    that touches this package is merged on its own, the commits between them
 *    in one batch. Every merge is checked (types, the upstream tests of this
 *    package, the fork build) and pushed once it passes. A conflict or a
 *    failed check stops the run and opens an issue naming the upstream commit;
 *    after a person resolves it on `main`, the next run continues from there.
 * 3. For the newest upstream release tag without a release branch, cut
 *    `release/<version>` from the tag, apply this fork's changes, check it,
 *    push it, and open an issue asking for the smoke check and the version
 *    confirmation. Nothing is published here.
 * 4. Disable upstream workflows that arrived with the merged commits.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const PACKAGE = relative(root, join(import.meta.dirname, '..'))
const UPSTREAM = 'https://github.com/deepseek-ai/deepseek-harness.git'
const LABEL = 'folders-sync'
const OWN_WORKFLOWS = new Set(['.github/workflows/folders-sync.yml', '.github/workflows/folders-release.yml'])
/** Paths this fork changes; a release branch receives their diff against upstream. */
const FORK_PATHS = [PACKAGE, 'tsconfig.host.json', ...OWN_WORKFLOWS]

function run(command: string, args: readonly string[]): void {
  execFileSync(command, args, { cwd: root, stdio: 'inherit' })
}

function git(args: readonly string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function succeeds(command: string, args: readonly string[]): boolean {
  try {
    execFileSync(command, args, { cwd: root, stdio: 'inherit' })
    return true
  } catch {
    return false
  }
}

function short(commit: string): string {
  return commit.slice(0, 10)
}

let lockfileHash: string | undefined
function install(): void {
  const hash = createHash('sha256').update(readFileSync(join(root, 'pnpm-lock.yaml'))).digest('hex')
  if (hash === lockfileHash) return
  run('pnpm', ['install', '--frozen-lockfile'])
  lockfileHash = hash
}

/** The gate every pushed commit passes: types, the package's upstream tests, and the fork build. */
function check(): boolean {
  try {
    install()
    run('pnpm', ['exec', 'tsx', 'scripts/compile-referenced-projects.ts', 'host-contracts'])
    run(process.execPath, [join(PACKAGE, 'fork/build.ts'), '--pack'])
    run('pnpm', ['exec', 'vitest', 'run', PACKAGE])
    return true
  } catch {
    return false
  }
}

function openIssue(title: string, body: string): void {
  const open = JSON.parse(execFileSync('gh', ['issue', 'list', '--state', 'open', '--label', LABEL, '--json', 'title'], {
    cwd: root, encoding: 'utf8',
  })) as Array<{ title: string }>
  if (open.some(issue => issue.title === title)) return
  run('gh', ['issue', 'create', '--title', title, '--label', LABEL, '--body', body])
}

function touchesPackage(commit: string): boolean {
  return !succeeds('git', ['diff', '--quiet', `${commit}^1`, commit, '--', PACKAGE])
}

function mirror(): void {
  if (!succeeds('git', ['push', 'origin', 'upstream/master:refs/heads/master'])) {
    console.warn('master is not a fast-forward of upstream master; the mirror was left unchanged')
  }
}

/** Merge upstream master into main step by step; returns false when a step is blocked. */
function syncMain(): boolean {
  const pending = git(['rev-list', '--reverse', '--first-parent', 'HEAD..upstream/master']).split('\n').filter(Boolean)
  if (pending.length === 0) return true
  const targets = pending.filter(touchesPackage)
  const head = pending.at(-1) as string
  if (targets.at(-1) !== head) targets.push(head)
  for (const target of targets) {
    const subject = git(['log', '-1', '--format=%s', target])
    if (!succeeds('git', ['merge', '--no-ff', '--no-edit', '-m', `Merge upstream ${short(target)}: ${subject}`, target])) {
      const conflicts = git(['diff', '--name-only', '--diff-filter=U'])
      run('git', ['merge', '--abort'])
      openIssue(`上游同步冲突：${short(target)}`, [
        `合并上游提交 ${target}（${subject}）时出现冲突，main 停在它之前。`,
        '',
        '冲突文件：',
        '',
        ...conflicts.split('\n').map(file => `- \`${file}\``),
        '',
        `在本地把这个提交合并进 main、按 \`${PACKAGE}/AGENTS.md\` 的规则解决冲突并推送，下一次同步会从这里继续。`,
      ].join('\n'))
      return false
    }
    if (!check()) {
      run('git', ['reset', '--hard', 'HEAD^'])
      openIssue(`上游同步检查失败：${short(target)}`, [
        `合并上游提交 ${target}（${subject}）后检查没有通过，main 停在它之前。失败输出见本次运行的日志。`,
        '',
        '在本地合并这个提交并修好我们的代码（不改上游测试）后推送 main，下一次同步会从这里继续。',
      ].join('\n'))
      return false
    }
    run('git', ['push', 'origin', 'HEAD:main'])
  }
  return true
}

/** Cut the release branch for the newest upstream tag that has none. */
function prepareRelease(): void {
  const tag = git(['tag', '--list', 'dsh-v*', '--sort=-creatordate']).split('\n')[0]
  if (tag === undefined || tag === '') return
  const version = tag.slice('dsh-v'.length)
  const branch = `release/${version}`
  if (succeeds('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch])) return
  const base = git(['merge-base', 'main', 'upstream/master'])
  const patch = join(root, '.git', 'folders-release.patch')
  writeFileSync(patch, execFileSync('git', ['diff', '--binary', base, 'main', '--', ...FORK_PATHS], { cwd: root }))
  run('git', ['checkout', '-B', branch, tag])
  const applied = succeeds('git', ['apply', '--3way', '--index', patch])
  if (!applied || !succeeds('git', ['commit', '-m', `Apply workspace folders to ${tag}`]) || !check()) {
    run('git', ['reset', '--hard'])
    run('git', ['checkout', 'main'])
    openIssue(`发布分支需要手动处理：${version}`, [
      `把 main 上的文件夹改动应用到上游标签 ${tag} 时${applied ? '检查没有通过' : '出现冲突'}，没有推送 ${branch}。`,
      '',
      `在本地从 ${tag} 切出 ${branch}，合入 main 上 \`${FORK_PATHS.join('`、`')}\` 的改动并通过检查后推送。`,
    ].join('\n'))
    return
  }
  run('git', ['push', 'origin', branch])
  run('git', ['checkout', 'main'])
  openIssue(`DSH ${version} 的发布分支已准备好`, [
    `${branch} 已从 ${tag} 切出，文件夹改动已应用并通过检查，本次运行的产物里有打好的 tarball。`,
    '',
    `1. DSH 升级到 ${version} 后，用这个分支的构建做页面冒烟检查：文件夹显示、菜单移动、拖入拖出、fluent theme。`,
    `2. 检查通过后，在 ${branch} 上修改 \`${PACKAGE}/fork/manifest.json\`：\`engines.dsh\` 改为 \`${version}\`，\`version\` 递增；同步 fork README 的版本对应表。`,
    '3. 推送后 folders-release 流水线发布到 npm，然后关闭本 issue。',
  ].join('\n'))
}

/** Keep only this fork's own workflows enabled. */
function disableUpstreamWorkflows(): void {
  const workflows = JSON.parse(execFileSync('gh', ['workflow', 'list', '--all', '--json', 'id,path,state'], {
    cwd: root, encoding: 'utf8',
  })) as Array<{ id: number; path: string; state: string }>
  for (const workflow of workflows) {
    if (workflow.state === 'active' && !OWN_WORKFLOWS.has(workflow.path)) run('gh', ['workflow', 'disable', String(workflow.id)])
  }
}

if (!succeeds('git', ['remote', 'get-url', 'upstream'])) run('git', ['remote', 'add', 'upstream', UPSTREAM])
run('git', ['fetch', '--no-tags', 'upstream', 'master'])
run('git', ['fetch', '--force', 'upstream', 'refs/tags/dsh-v*:refs/tags/dsh-v*'])
mirror()
const synced = syncMain()
disableUpstreamWorkflows()
if (synced) prepareRelease()
