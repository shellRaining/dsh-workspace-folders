# 工作区文件夹 fork 维护规则

本目录是上游 `@deepseek-ai/dsh-client-ui-workspace` 加上文件夹功能后的 fork，发布为 `@shellraining/dsh-workspace-folders`。仓库根目录的 AGENTS.md、CLAUDE.md 和其他包都属于上游，不改。设计和取舍见 [fork/PLAN.md](fork/PLAN.md)。

## 文件归属

我们自己的文件，上游没有，合并时不会冲突：

- `fork/`：发布清单覆盖层 `manifest.json`、bundle patch、npm README、展示用的 locale 和图标、构建脚本 `build.ts`、同步脚本 `sync.ts`。
- `src/folders/`：宿主端的 `workspaceFolders` Remote 和共享类型。
- `src/client/folders/`：浏览器端的文件夹状态、菜单、对话框和树渲染。
- 本文件，以及仓库根目录的 `.github/workflows/folders-sync.yml`、`folders-release.yml`。

上游文件里的接入点，改动保持在几行以内，新增的属性和注释都带 `Workspace folders fork` 字样：

- `package.json`：`./typert`、`./remote`、`./folders` 三个导出和对应的 `files` 条目。Typert 生成器要求这些字段，包名和版本号保持上游原样。
- `src/index.ts`：在空的 `apply` 后面加默认导出，并把上游的 `Config` 挂到默认导出上。上游测试要求 `apply` 和 `Config` 继续存在，Loader 优先使用默认导出，同步给浏览器的 Config 也从默认导出上读取。
- `src/client/index.ts`：调用 `installWorkspaceFolders`，把 `folders` 放进浏览器的注入对象。
- `src/client/contract/slots.ts`：`WorkspaceBrowserInjected` 的可选字段 `folders`。
- `src/client/rows/WorkspaceBrowser.tsx`：`useFolderTree` 的调用、`split`、`commitDrop`、`rowKeys`、`headerDrop`、`render`、工作区行 `onCreate` 里的 `leaveDraft` 几处，以及 `FolderDialogs`。
- `src/client/rows/Rows.tsx`：工作区行的可选属性 `sessionDrop`。
- `tsconfig.host.json`：`files` 加入 `src/folders/` 的两个文件，`references` 加入 `typert/protocol`。上游 master 在 0.2.2-rc.5 之后自带这个文件，并在仓库根目录的 `tsconfig.host.json` 里引用它，`main` 不再改根配置；从更早的标签切出的发布分支没有这个文件，仍按旧方式新建它，并在根配置里加一行引用。

## 改动规则

- 新功能写进上面列出的自有目录，上游文件只加接入点。不格式化、不重命名、不顺手修上游代码。
- `folders` 缺省时所有接入点都是恒等变换，浏览器和官方包完全一致。上游测试不传 `folders`，靠这一点保持全部通过。
- 不新增、不修改测试，上游测试原样作为检查。我们的改动让上游测试失败时，改我们的代码。
- 不往 `apply` 的 `inject` 列表、`shell.overlay` 里加东西，上游测试逐项断言了它们。文件夹的服务通过 `ctx.inject(['remote.workspaceFolders'])` 动态等待，对话框渲染在浏览器内部。
- 菜单项在 Remote 返回数据前不出现，上游测试断言的菜单内容因此不变。
- 不改依赖，不动 `pnpm-lock.yaml`。宿主端只在运行时引用 DSH 安装里已有的包，构建时由 `fork/build.ts` 把它们声明为 peer。

## 合并上游

定时任务每天把上游 master 合进 `main`，遇到冲突或检查失败就开 issue 停下。人工处理时：

1. 在本地 `git fetch upstream`，把 issue 里的上游提交合进 `main`。
2. 解决冲突时保留上游的改动，再把接入点按原意放回去。上游大改浏览器结构时，先读懂新结构再重新接入，不要硬套旧补丁。
3. 运行下面的检查，全部通过后推送 `main`，下一次定时任务会从这里继续。

## 检查

首次需要完整安装上游依赖（pnpm 版本由根 `packageManager` 固定，Node 24.9 以上）：

```sh
pnpm install --frozen-lockfile
pnpm exec tsx scripts/compile-referenced-projects.ts host-contracts
node packages/client/ui-workspace/fork/build.ts --pack
pnpm exec vitest run packages/client/ui-workspace
```

`build.ts` 先按上游包名做类型检查，再临时改用 fork 包名生成 Typert 产物和打包，最后恢复 `package.json` 并重新生成上游名的 Typert 产物。默认输出到 `fork/dist`（已忽略）。

## 本地页面验证

把 profile 链接到仓库外的输出目录，这样运行时依赖和正式安装一样从 DSH 安装里解析：

```sh
node packages/client/ui-workspace/fork/build.ts --out ~/.local/share/dsh-workspace-folders/package
```

profile 的 `package.json` 写 npm 版本号，`pnpm-workspace.yaml` 的 `overrides` 写 `link:` 到上面的目录，然后在 profile 里执行 `dsh plugin --profile <名称> install`。`desktop` profile 只能用桌面端自带的 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` 执行这条命令，其他 `dsh` 会拒绝管理它。宿主端改动要重启 DSH 才生效。

## 发布

- 版本号和 `engines.dsh` 只写在 `fork/manifest.json`，`main` 上不改上游的版本号。
- 上游每打一个 `dsh-v*` 标签，定时任务从标签切出 `release/<版本>`，应用 `main` 相对上游的改动并检查，然后开 issue。
- 页面冒烟检查通过后，在发布分支上把 `engines.dsh` 改成该 DSH 版本、递增 `version`，同步 `fork/README.md` 的版本对应表并推送，`folders-release` 流水线用 npm trusted publishing 发布。
- `engines.dsh` 只写一个确切版本。旧代码跑在新宿主上可能出错，而官方列表已被停用，出错时没有退路；版本不符时 DSH 跳过本插件，侧栏回到官方列表。
