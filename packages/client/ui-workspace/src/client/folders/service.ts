/**
 * Workspace folders, browser half: the folder state read from the Host
 * `workspaceFolders` Remote, the folder collapse state kept in this browser,
 * the folder menu actions, and the dialog requests those actions raise.
 * Until the Remote answers, every folder surface stays absent and the
 * browser behaves like the official package.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import {
  IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconFolderOpenRegular, IconNewChatOutlineRegular, IconProjectAddOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFolder, WorkspaceFolderState } from '../../folders/types.ts'
import remote from '../../../lib/typert.remote-client.js'
import { en, zh, type WorkspaceFolderKey } from './locales.ts'

/** Locale namespace owned by the folder layer. */
export const FOLDER_NS = 'workspaceFolders'

/** localStorage key of the folder ids folded in this browser. */
const COLLAPSED_STORAGE_KEY = 'dsh.workspace.folders.collapsed.v1'

declare module '@deepseek-ai/dsh-client-ui-context-menu/client' {
  interface ContextMenuTargetMap {
    /** One sidebar folder row. */
    workspaceFolder: { readonly folderId: string; readonly workspacePath: string; readonly name: string }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace folder rows, menus, dialogs, and notices. */
    workspaceFolders: WorkspaceFolderKey
  }
}

/** A blank Session started from a folder menu; it joins the folder once it stops being blank. */
export interface FolderDraft {
  readonly sessionId: SessionId
  readonly folderId: string
}

/** Folder state as the browser renders it. */
export interface FolderView extends WorkspaceFolderState {
  /** `ready` once the Host answered; folders render only then. */
  readonly phase: 'loading' | 'ready' | 'unavailable'
  /** The blank Session a folder's New session opened, shown inside that folder while it stays blank and selected. */
  readonly draft?: FolderDraft
}

/** Open a Workspace's New session, naming the reused or created Session before it is selected. */
export type OpenWorkspaceSession = (workspaceId: WorkspaceId, beforeOpen: (sessionId: SessionId) => void) => Promise<void>

/** One folder dialog the menus asked for. */
export type FolderDialogRequest =
  | { readonly kind: 'create'; readonly workspaceId: string; readonly workspacePath: string; readonly sessionId: SessionId | null }
  | { readonly kind: 'rename'; readonly folder: WorkspaceFolder }
  | { readonly kind: 'delete'; readonly folder: WorkspaceFolder }

/** Translate one folder-namespace key (the shared common vocabulary included). */
export type FolderTranslate = TranslateNS<'workspaceFolders'>

/** What the browser region reads and drives. */
export interface FolderBrowserShare {
  readonly state: ObservableSnapshot<FolderView>
  /** Folder ids folded in this browser. */
  readonly collapsed: ObservableSnapshot<readonly string[]>
  /** The folded folder ids, ignoring a malformed stored value. */
  collapsedIds(): readonly string[]
  readonly dialog: ObservableSnapshot<FolderDialogRequest | null>
  readonly t: FolderTranslate
  setCollapsed(folderId: string, collapsed: boolean): void
  /** Move a Session into a folder (or out with null); applied at once, reverted with a notice on failure. */
  move(sessionId: SessionId, folderId: string | null): void
  create(request: Extract<FolderDialogRequest, { kind: 'create' }>, name: string): Promise<void>
  rename(folderId: string, name: string): Promise<void>
  remove(folderId: string): Promise<void>
  settleDialog(): void
}

/** The generated namespace this module calls. `remove` is reserved by the namespace service. */
type FolderRemote = {
  read(): Promise<RemoteResult<WorkspaceFolderState>>
  create(workspacePath: string, name: string, sessionId: string | null): Promise<RemoteResult<WorkspaceFolderState>>
  rename(folderId: string, name: string): Promise<RemoteResult<WorkspaceFolderState>>
  delete(folderId: string): Promise<RemoteResult<WorkspaceFolderState>>
  move(sessionId: string, folderId: string | null): Promise<RemoteResult<WorkspaceFolderState>>
}

/** A refused folder change; `code` is the Remote failure code. */
export class FolderCallError extends Error {
  override name = 'FolderCallError'

  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Icon keys this layer adds to the shared menu icon table. */
const ICON = {
  new: 'workspaceFolders.new',
  move: 'workspaceFolders.move',
  folder: 'workspaceFolders.folder',
  out: 'workspaceFolders.out',
  session: 'workspaceFolders.newSession',
} as const

/**
 * Folders of one Workspace directory in display order: by name, numbers compared by value.
 * @param folders - every folder.
 * @param workspacePath - Workspace directory in Host spelling.
 * @returns the Workspace's folders, sorted.
 */
export function foldersOf(folders: readonly WorkspaceFolder[], workspacePath: string): WorkspaceFolder[] {
  return folders
    .filter(folder => folder.workspacePath === workspacePath)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }) || a.createdAt - b.createdAt)
}

/**
 * Install the folder layer and return the share the browser region reads.
 * @param ctx - the workspace plugin's client context.
 * @param expandWorkspace - unfold one Workspace group.
 * @param openWorkspace - open a Workspace's New session, as the Workspace row's button does.
 * @returns the browser share.
 */
export function installWorkspaceFolders(
  ctx: Context, sessions: ISessions, expandWorkspace: (workspaceId: string) => void, openWorkspace: OpenWorkspaceSession,
): FolderBrowserShare {
  ctx.effect(() => ctx.locale.register(FOLDER_NS, { zh, en }), 'workspace-folders: dictionaries')
  const t = ctx.locale.bind(FOLDER_NS)
  const state = createSnapshotStore<FolderView>({ phase: 'loading', folders: [], members: {} })
  const collapsed = createSnapshotStore<readonly string[]>([], { persist: { name: COLLAPSED_STORAGE_KEY } })
  const dialog = createSnapshotStore<FolderDialogRequest | null>(null)
  let api: FolderRemote | undefined
  /** Advances on every Host request; only the latest request's answer is applied. */
  let revision = 0
  const collapsedIds = (): readonly string[] => {
    const value: unknown = collapsed.getSnapshot()
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  }
  const setCollapsedId = (folderId: string, folded: boolean): void => {
    const current = collapsedIds()
    if (current.includes(folderId) === folded) return
    collapsed.set(folded ? [...current, folderId] : current.filter(id => id !== folderId))
  }

  const accept = (value: WorkspaceFolderState): void => {
    const { draft } = state.getSnapshot()
    state.set({ phase: 'ready', folders: value.folders, members: value.members, ...draft === undefined ? {} : { draft } })
  }
  const setDraft = (draft: FolderDraft | undefined): void => {
    const { draft: _previous, ...rest } = state.getSnapshot()
    state.set(draft === undefined ? rest : { ...rest, draft })
  }
  const refresh = async (): Promise<void> => {
    if (api === undefined) return
    const observed = ++revision
    const result = await api.read()
    if (observed !== revision) return
    if (result.ok) accept(result.value)
    else {
      console.warn('workspace folders: read failed', result.error)
      if (state.getSnapshot().phase === 'loading') state.set({ ...state.getSnapshot(), phase: 'unavailable' })
    }
  }
  const refreshQuietly = (): void => {
    refresh().catch((error: unknown) => { console.warn('workspace folders: read failed', error) })
  }
  const call = async (operation: (remote: FolderRemote) => Promise<RemoteResult<WorkspaceFolderState>>): Promise<void> => {
    if (api === undefined) throw new FolderCallError('workspaceFolders/unavailable', t('notice.unavailable'))
    const observed = ++revision
    const result = await operation(api)
    if (result.ok) {
      if (observed === revision) accept(result.value)
      return
    }
    // A refused change may come from a stale view, for example a folder deleted in another window.
    refreshQuietly()
    throw new FolderCallError(result.error.code, result.error.message)
  }

  ctx.effect(() => {
    let disposed = false
    let unmount: (() => Promise<void>) | undefined
    ctx.remote.$mount(remote).then(async (dispose) => {
      if (disposed) await dispose()
      else unmount = dispose
    }).catch((error: unknown) => {
      if (disposed) return
      console.warn('workspace folders: Remote unavailable', error)
      state.set({ ...state.getSnapshot(), phase: 'unavailable' })
    })
    return async () => {
      disposed = true
      await unmount?.()
    }
  }, 'workspace-folders: Remote')
  ctx.inject(['remote.workspaceFolders'], (child) => {
    child.effect(() => {
      api = child.remote.workspaceFolders
      refreshQuietly()
      return () => {
        api = undefined
        revision++
        // Without the Host namespace the browser falls back to the official view.
        state.set({ ...state.getSnapshot(), phase: 'loading' })
      }
    }, 'workspace-folders: state')
  })
  ctx.on('connection/reset', refreshQuietly)

  /** Move a Session; with `notice`, confirm a menu move, whose row may leave the view. */
  const move = (sessionId: SessionId, folderId: string | null, notice?: string): void => {
    const before = state.getSnapshot()
    const previous = before.members[sessionId] ?? null
    if (before.phase !== 'ready' || previous === folderId) return
    const withMember = (members: Readonly<Record<string, string>>, value: string | null): Record<string, string> => value === null
      ? Object.fromEntries(Object.entries(members).filter(([id]) => id !== sessionId))
      : { ...members, [sessionId]: value }
    state.set({ ...before, members: withMember(before.members, folderId) })
    call(remote => remote.move(sessionId, folderId)).then(() => {
      if (notice !== undefined) ctx.contextMenus.notify(notice, true)
    }).catch((error: unknown) => {
      console.warn('workspace folders: move rejected', error)
      const current = state.getSnapshot()
      if ((current.members[sessionId] ?? null) === folderId) state.set({ ...current, members: withMember(current.members, previous) })
      ctx.contextMenus.notify(t('notice.moveFailed'), false)
    })
  }
  const request = (next: FolderDialogRequest): void => { dialog.set(next) }

  // A folder's New session stays blank until its first prompt; it joins the
  // folder then, and is dropped once another Session takes the main view.
  const settleDraft = (): void => {
    const { draft, folders } = state.getSnapshot()
    if (draft === undefined) return
    const summary = sessions.list.getSnapshot().byId[draft.sessionId]
    if (summary === undefined) return
    if (!summary.blank) {
      // Membership first, so the row never leaves the folder in between.
      if (folders.some(folder => folder.id === draft.folderId)) move(draft.sessionId, draft.folderId)
      setDraft(undefined)
      return
    }
    if ((summary.retainedBy.mainView ?? 0) === 0) setDraft(undefined)
  }
  ctx.effect(() => sessions.list.subscribe(settleDraft), 'workspace-folders: new session in folder')
  const startInFolder = (workspaceId: WorkspaceId, folderId: string): void => {
    expandWorkspace(workspaceId)
    setCollapsedId(folderId, false)
    openWorkspace(workspaceId, (sessionId) => { setDraft({ sessionId, folderId }) }).then(settleDraft).catch((error: unknown) => {
      console.warn('workspace folders: new session failed', error)
    })
  }

  ctx.slots.inject('contextMenu.icon', function* () {
    for (const [key, Icon] of [
      [ICON.new, IconProjectAddOutlineRegular], [ICON.move, IconFolderOpenRegular],
      [ICON.folder, IconFolderCloseRegular], [ICON.out, IconFolderOpenOutlineRegular], [ICON.session, IconNewChatOutlineRegular],
    ] as const) yield ctx.slots.register({ name: 'contextMenu.icon', key }, Icon)
  })
  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspace.folder', target: 'workspace', order: 150,
    observe: () => [state, ctx.locale],
    resolve: ({ workspaceId, path }) => state.getSnapshot().phase !== 'ready' ? [] : [{
      id: 'new-folder', label: t('folder.new'), icon: { key: ICON.new },
      run: () => { request({ kind: 'create', workspaceId, workspacePath: path, sessionId: null }) },
    }],
  }), 'workspace-folders: workspace menu')
  ctx.effect(() => ctx.contextMenus.register({
    id: 'session.folder', target: 'session', order: 350,
    observe: () => [state, ctx.workspaces.list, ctx.locale],
    resolve: ({ sessionId }) => {
      const snapshot = state.getSnapshot()
      if (snapshot.phase !== 'ready') return []
      const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.sessionIds.includes(sessionId))
      if (workspace === undefined) return []
      const folders = foldersOf(snapshot.folders, workspace.path)
      const current = folders.find(folder => folder.id === snapshot.members[sessionId])
      // The current folder stays listed, disabled, so the submenu also says where the Session is.
      const children: MenuAction[] = [
        ...folders.map(folder => ({
          id: `folder-${folder.id}`, label: folder.name, icon: { key: ICON.folder }, disabled: folder === current,
          run: () => { move(sessionId, folder.id, t('notice.moved', { name: folder.name })) },
        })),
        {
          id: 'new-folder', label: t('folder.newEllipsis'), icon: { key: ICON.new }, separatorBefore: folders.length > 0,
          run: () => { request({ kind: 'create', workspaceId: workspace.workspaceId, workspacePath: workspace.path, sessionId }) },
        },
        ...current === undefined ? [] : [{
          id: 'remove-from-folder', label: t('menu.removeFromFolder'), icon: { key: ICON.out }, separatorBefore: true,
          run: () => { move(sessionId, null, t('notice.movedOut', { name: current.name })) },
        }],
      ]
      return [{ id: 'move-to-folder', label: t('menu.moveToFolder'), icon: { key: ICON.move }, children }]
    },
  }), 'workspace-folders: session menu')
  const folderNamed = (folderId: string): WorkspaceFolder | undefined =>
    state.getSnapshot().folders.find(folder => folder.id === folderId)
  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspaceFolder.newSession', target: 'workspaceFolder', order: 50,
    observe: () => [ctx.workspaces.list, ctx.locale],
    resolve: ({ folderId, workspacePath }) => {
      const workspace = ctx.workspaces.list.getSnapshot().items.find(item => item.path === workspacePath)
      if (workspace === undefined || !ctx.remoteAccess.source('workspace', workspace.workspaceId, 'session/create').getSnapshot()) return []
      return [{
        id: 'new-session', label: t('folder.newSession'), icon: { key: ICON.session },
        run: () => { startInFolder(workspace.workspaceId, folderId) },
      }]
    },
  }), 'workspace-folders: folder new session')
  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspaceFolder.rename', target: 'workspaceFolder', order: 100,
    observe: () => [ctx.locale],
    resolve: ({ folderId }) => [{
      id: 'rename', label: t('folder.rename'), icon: { key: 'workspace.rename' },
      run: () => {
        const folder = folderNamed(folderId)
        if (folder !== undefined) request({ kind: 'rename', folder })
      },
    }],
  }), 'workspace-folders: folder rename')
  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspaceFolder.delete', target: 'workspaceFolder', order: 300,
    observe: () => [ctx.locale],
    resolve: ({ folderId }) => [{
      id: 'delete', label: t('folder.delete'), icon: { key: 'workspace.delete' }, danger: true, separatorBefore: true,
      run: () => {
        const folder = folderNamed(folderId)
        if (folder !== undefined) request({ kind: 'delete', folder })
      },
    }],
  }), 'workspace-folders: folder delete')

  return {
    state,
    collapsed,
    dialog,
    t,
    collapsedIds,
    setCollapsed: setCollapsedId,
    move: (sessionId, folderId) => { move(sessionId, folderId) },
    create: async (request, name) => {
      await call(remote => remote.create(request.workspacePath, name, request.sessionId))
      // A folder made from a folded Workspace's menu would otherwise appear out of sight.
      expandWorkspace(request.workspaceId)
    },
    rename: (folderId, name) => call(remote => remote.rename(folderId, name)),
    remove: async (folderId) => {
      await call(remote => remote.delete(folderId))
      const current = collapsedIds()
      if (current.includes(folderId)) collapsed.set(current.filter(id => id !== folderId))
    },
    settleDialog: () => { dialog.set(null) },
  }
}
