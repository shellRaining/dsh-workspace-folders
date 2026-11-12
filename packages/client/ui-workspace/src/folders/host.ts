/**
 * Workspace folders, Host half: the `workspaceFolders` Remote namespace over
 * one storage domain (`workspace_folders` under the Harness storages root).
 * Each call applies one change and answers the whole state, so several
 * browsers editing at once never overwrite each other's folders.
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { FOLDER_NAME_MAX_LENGTH, type WorkspaceFolder, type WorkspaceFolderState } from './types.ts'

export type { WorkspaceFolder, WorkspaceFolderState } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `workspaceFolders` Remote namespace. */
    workspaceFolders: WorkspaceFoldersController
  }
}

/** A stored folder record; the table key is the folder id. */
interface StoredFolder {
  readonly workspacePath: string
  readonly name: string
  readonly createdAt: number
}

/** One KV table of the domain, as far as this owner uses it. */
interface FolderTable<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
  deleteMany(keys: readonly string[]): Promise<number>
}

/** The opened domain: folder records and Session memberships (Session id to folder id). */
interface FolderDomain {
  table(name: 'folders'): FolderTable<StoredFolder>
  table(name: 'members'): FolderTable<string>
  close(): Promise<void>
}

/** The Host `storageDomain` facility, reduced to the one call this owner makes. */
interface FolderStorage {
  open(spec: typeof folderDomain): Promise<FolderDomain>
}

/** Parsers the domain loader validates stored records with; a failing record is backed up and skipped. */
const storedFolder = {
  parse(raw: unknown): StoredFolder {
    if (typeof raw !== 'object' || raw === null) throw new TypeError('folder record is not an object')
    const { workspacePath, name, createdAt } = raw as Record<string, unknown>
    if (typeof workspacePath !== 'string' || workspacePath === '') throw new TypeError('folder workspacePath is invalid')
    if (typeof name !== 'string' || name.trim() === '') throw new TypeError('folder name is invalid')
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) throw new TypeError('folder createdAt is invalid')
    return { workspacePath, name, createdAt }
  },
}

const storedMember = {
  parse(raw: unknown): string {
    if (typeof raw !== 'string' || raw === '') throw new TypeError('folder membership is invalid')
    return raw
  },
}

const folderDomain = {
  name: 'workspace_folders',
  version: 1,
  invalidRecords: 'backup-and-skip',
  tables: {
    folders: { valueSchema: storedFolder },
    members: { valueSchema: storedMember },
  },
} as const

/** Longest accepted Workspace path or Session id. */
const IDENTITY_MAX_LENGTH = 4096

function invalid(message: string): RemoteError<'workspaceFolders/invalid'> {
  return new RemoteError('workspaceFolders/invalid', message, {})
}

function notFound(): RemoteError<'workspaceFolders/not-found'> {
  return new RemoteError('workspaceFolders/not-found', 'The folder no longer exists', {})
}

function identity(value: string, label: string): string {
  if (value === '' || value.length > IDENTITY_MAX_LENGTH) throw invalid(`${label} is invalid`)
  return value
}

function folderName(value: string): string {
  const name = value.trim()
  if (name === '' || name.length > FOLDER_NAME_MAX_LENGTH) throw invalid('Folder name is blank or too long')
  return name
}

/** A fresh folder id: 96 random bits in hex. */
function folderId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, '0')).join('')
}

function snapshot(domain: FolderDomain): WorkspaceFolderState {
  const folders: WorkspaceFolder[] = []
  for (const [id, folder] of domain.table('folders').entries()) folders.push({ id, ...folder })
  const members: Record<string, string> = {}
  for (const [sessionId, folderId] of domain.table('members').entries()) members[sessionId] = folderId
  return { folders, members }
}

/** Host service backing the `workspaceFolders` Remote namespace. */
export default class WorkspaceFoldersController extends TypertRemoteService {
  static inject = ['typert', 'storageDomain']

  private readonly ready: Promise<FolderDomain>

  /** @param ctx - Host context carrying the storage domain facility. */
  constructor(ctx: Context) {
    super(ctx, 'workspaceFolders', { namespace: 'workspaceFolders' })
    const storage = (ctx as unknown as { storageDomain: FolderStorage }).storageDomain
    this.ready = storage.open(folderDomain)
    // An open failure surfaces through every Remote call; this keeps it from
    // also reporting as an unhandled rejection.
    this.ready.catch((error: unknown) => { ctx.logger.error('workspace folders: storage unavailable', error) })
    ctx.effect(() => async () => {
      const domain = await this.ready.catch(() => undefined)
      await domain?.close()
    }, 'workspace-folders: storage domain')
  }

  /**
   * Read every folder and membership.
   * @returns the current state.
   */
  @Remote
  async read(): Promise<WorkspaceFolderState> {
    return snapshot(await this.ready)
  }

  /**
   * Create a folder in one Workspace directory, optionally moving one Session into it.
   * @param workspacePath - Workspace directory in Host spelling.
   * @param name - folder name; surrounding whitespace is dropped.
   * @param sessionId - Session to move into the new folder, or null.
   * @returns the state after the change.
   */
  @Remote
  async create(workspacePath: string, name: string, sessionId: string | null): Promise<WorkspaceFolderState> {
    const domain = await this.ready
    const path = identity(workspacePath, 'Workspace path')
    const title = folderName(name)
    const member = sessionId === null ? null : identity(sessionId, 'Session id')
    this.assertUnique(domain, path, title, undefined)
    const id = folderId()
    await domain.table('folders').put(id, { workspacePath: path, name: title, createdAt: Date.now() })
    if (member !== null) await domain.table('members').put(member, id)
    return snapshot(domain)
  }

  /**
   * Rename one folder.
   * @param folderId - folder to rename.
   * @param name - new name; surrounding whitespace is dropped.
   * @returns the state after the change.
   */
  @Remote
  async rename(folderId: string, name: string): Promise<WorkspaceFolderState> {
    const domain = await this.ready
    const folder = domain.table('folders').get(folderId)
    if (folder === undefined) throw notFound()
    const title = folderName(name)
    this.assertUnique(domain, folder.workspacePath, title, folderId)
    await domain.table('folders').put(folderId, { ...folder, name: title })
    return snapshot(domain)
  }

  /**
   * Delete one folder. Its Sessions return to the Workspace; none is deleted or archived.
   * @param folderId - folder to delete.
   * @returns the state after the change.
   */
  @Remote
  async remove(folderId: string): Promise<WorkspaceFolderState> {
    const domain = await this.ready
    const members = domain.table('members')
    const released = [...members.entries()].filter(([, owner]) => owner === folderId).map(([sessionId]) => sessionId)
    await members.deleteMany(released)
    await domain.table('folders').delete(folderId)
    return snapshot(domain)
  }

  /**
   * Move one Session into a folder, or out of every folder.
   * @param sessionId - Session to move.
   * @param folderId - destination folder, or null to leave the current folder.
   * @returns the state after the change.
   */
  @Remote
  async move(sessionId: string, folderId: string | null): Promise<WorkspaceFolderState> {
    const domain = await this.ready
    const member = identity(sessionId, 'Session id')
    if (folderId === null) {
      await domain.table('members').delete(member)
    } else {
      if (domain.table('folders').get(folderId) === undefined) throw notFound()
      await domain.table('members').put(member, folderId)
    }
    return snapshot(domain)
  }

  private assertUnique(domain: FolderDomain, workspacePath: string, name: string, self: string | undefined): void {
    for (const [id, folder] of domain.table('folders').entries()) {
      if (id !== self && folder.workspacePath === workspacePath && folder.name === name) {
        throw new RemoteError('workspaceFolders/duplicate', 'A folder with this name already exists', {})
      }
    }
  }
}
