/**
 * Workspace folder wire vocabulary shared by the Host Remote and the browser.
 * Folders only arrange the sidebar: they never touch Session working
 * directories, logs, or Workspace membership.
 */
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** One sidebar folder inside a registered Workspace directory. */
export interface WorkspaceFolder {
  /** Stable folder identity. */
  readonly id: string
  /**
   * Workspace directory in Host spelling. Folders follow the directory rather
   * than the Workspace id, so removing and re-adding a Workspace keeps them.
   */
  readonly workspacePath: string
  /** Trimmed display name, unique within its Workspace. */
  readonly name: string
  /** Creation time in epoch milliseconds. */
  readonly createdAt: number
}

/** Every folder plus the folder each Session belongs to. */
export interface WorkspaceFolderState {
  readonly folders: readonly WorkspaceFolder[]
  /** Session id to folder id; a Session absent here is outside every folder. */
  readonly members: Readonly<Record<string, string>>
}

/** Longest accepted folder name, in UTF-16 code units. */
export const FOLDER_NAME_MAX_LENGTH = 80

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A blank, overlong, or otherwise unusable folder name or argument. */
    'workspaceFolders/invalid': Record<string, never>
    /** Another folder in the same Workspace already has this name. */
    'workspaceFolders/duplicate': Record<string, never>
    /** The addressed folder no longer exists. */
    'workspaceFolders/not-found': Record<string, never>
  }
}
