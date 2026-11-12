/**
 * Workspace folders, browser half: the folder state read from the Host
 * `workspaceFolders` Remote, the folder collapse state kept in this browser,
 * the folder menu actions, and the dialog requests those actions raise.
 * Until the Remote answers, every folder surface stays absent and the
 * browser behaves like the official package.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconFolderOpenRegular, IconProjectAddOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuAction } from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
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

/** Folder state as the browser renders it. */
export interface FolderView extends WorkspaceFolderState {
  /** `ready` once the Host answered; folders render only then. */
  readonly phase: 'loading' | 'ready' | 'unavailable'
}

/** One folder dialog the menus asked for. */
export type FolderDialogRequest =
  | { readonly kind: 'create'; readonly workspacePath: string; readonly sessionId: SessionId | null }
  | { readonly kind: 'rename'; readonly folder: WorkspaceFolder }
  | { readonly kind: 'delete'; readonly folder: WorkspaceFolder }

/** Translate one folder-namespace key (the shared common vocabulary included). */
export type FolderTranslate = TranslateNS<'workspaceFolders'>

/** What the browser region reads and drives. */
export interface FolderBrowserShare {
  readonly state: ObservableSnapshot<FolderView>
  /** Folder ids folded in this browser. */
  readonly collapsed: ObservableSnapshot<readonly string[]>
  readonly dialog: ObservableSnapshot<FolderDialogRequest | null>
  readonly t: FolderTranslate
  setCollapsed(folderId: string, collapsed: boolean): void
  /** Move a Session into a folder (or out with null); applied at once, reverted with a notice on failure. */
  move(sessionId: SessionId, folderId: string | null): void
  create(workspacePath: string, name: string, sessionId: SessionId | null): Promise<void>
  rename(folderId: string, name: string): Promise<void>
  remove(folderId: string): Promise<void>
  settleDialog(): void
}

/** The generated namespace this module calls. */
type FolderRemote = {
  read(): Promise<RemoteResult<WorkspaceFolderState>>
  create(workspacePath: string, name: string, sessionId: string | null): Promise<RemoteResult<WorkspaceFolderState>>
  rename(folderId: string, name: string): Promise<RemoteResult<WorkspaceFolderState>>
  remove(folderId: string): Promise<RemoteResult<WorkspaceFolderState>>
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
 * @returns the browser share.
 */
export function installWorkspaceFolders(ctx: Context): FolderBrowserShare {
  ctx.effect(() => ctx.locale.register(FOLDER_NS, { zh, en }), 'workspace-folders: dictionaries')
  const t = ctx.locale.bind(FOLDER_NS)
  const state = createSnapshotStore<FolderView>({ phase: 'loading', folders: [], members: {} })
  const collapsed = createSnapshotStore<readonly string[]>([], { persist: { name: COLLAPSED_STORAGE_KEY } })
  const dialog = createSnapshotStore<FolderDialogRequest | null>(null)
  let api: FolderRemote | undefined
  let revision = 0

  const accept = (value: WorkspaceFolderState): void => {
    state.set({ phase: 'ready', folders: value.folders, members: value.members })
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
  const call = async (operation: (remote: FolderRemote) => Promise<RemoteResult<WorkspaceFolderState>>): Promise<void> => {
    if (api === undefined) throw new Error(t('notice.unavailable'))
    revision++
    const result = await operation(api)
    if (result.ok) {
      accept(result.value)
      return
    }
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
      refresh().catch((error: unknown) => { console.warn('workspace folders: read failed', error) })
      return () => { api = undefined }
    }, 'workspace-folders: state')
  })
  ctx.on('connection/reset', () => {
    refresh().catch((error: unknown) => { console.warn('workspace folders: read failed', error) })
  })

  const move = (sessionId: SessionId, folderId: string | null): void => {
    const before = state.getSnapshot()
    if (before.phase !== 'ready' || (before.members[sessionId] ?? null) === folderId) return
    const members = folderId === null
      ? Object.fromEntries(Object.entries(before.members).filter(([id]) => id !== sessionId))
      : { ...before.members, [sessionId]: folderId }
    state.set({ ...before, members })
    call(remote => remote.move(sessionId, folderId)).catch((error: unknown) => {
      console.warn('workspace folders: move rejected', error)
      ctx.contextMenus.notify(t('notice.moveFailed'), false)
      refresh().catch(() => {})
    })
  }
  const request = (next: FolderDialogRequest): void => { dialog.set(next) }

  ctx.slots.inject('contextMenu.icon', function* () {
    for (const [key, Icon] of [
      [ICON.new, IconProjectAddOutlineRegular], [ICON.move, IconFolderOpenRegular],
      [ICON.folder, IconFolderCloseRegular], [ICON.out, IconFolderOpenOutlineRegular],
    ] as const) yield ctx.slots.register({ name: 'contextMenu.icon', key }, Icon)
  })
  ctx.effect(() => ctx.contextMenus.register({
    id: 'workspace.folder', target: 'workspace', order: 150,
    observe: () => [state, ctx.locale],
    resolve: ({ path }) => state.getSnapshot().phase !== 'ready' ? [] : [{
      id: 'new-folder', label: t('folder.new'), icon: { key: ICON.new },
      run: () => { request({ kind: 'create', workspacePath: path, sessionId: null }) },
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
      const current = snapshot.members[sessionId]
      const folders = foldersOf(snapshot.folders, workspace.path)
      const inFolder = folders.some(folder => folder.id === current)
      const targets = folders.filter(folder => folder.id !== current)
      const children: MenuAction[] = [
        ...targets.map(folder => ({
          id: `folder-${folder.id}`, label: folder.name, icon: { key: ICON.folder },
          run: () => { move(sessionId, folder.id) },
        })),
        {
          id: 'new-folder', label: t('folder.newEllipsis'), icon: { key: ICON.new }, separatorBefore: targets.length > 0,
          run: () => { request({ kind: 'create', workspacePath: workspace.path, sessionId }) },
        },
        ...inFolder ? [{
          id: 'remove-from-folder', label: t('menu.removeFromFolder'), icon: { key: ICON.out },
          run: () => { move(sessionId, null) },
        }] : [],
      ]
      return [{ id: 'move-to-folder', label: t('menu.moveToFolder'), icon: { key: ICON.move }, children }]
    },
  }), 'workspace-folders: session menu')
  const folderNamed = (folderId: string): WorkspaceFolder | undefined =>
    state.getSnapshot().folders.find(folder => folder.id === folderId)
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
    setCollapsed: (folderId, folded) => {
      const current = collapsed.getSnapshot()
      if (current.includes(folderId) === folded) return
      collapsed.set(folded ? [...current, folderId] : current.filter(id => id !== folderId))
    },
    move,
    create: (workspacePath, name, sessionId) => call(remote => remote.create(workspacePath, name, sessionId)),
    rename: (folderId, name) => call(remote => remote.rename(folderId, name)),
    remove: async (folderId) => {
      await call(remote => remote.remove(folderId))
      const current = collapsed.getSnapshot()
      if (current.includes(folderId)) collapsed.set(current.filter(id => id !== folderId))
    },
    settleDialog: () => { dialog.set(null) },
  }
}
