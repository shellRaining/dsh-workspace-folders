/**
 * The folder layer inside the grouped Session tree. SessionTree hands its
 * derived groups, drag state, and Session row renderer to {@link useFolderTree};
 * the hook moves folder members out of each Workspace group into folder
 * sections rendered between the child Workspaces and the remaining Sessions,
 * and resolves drops that cross a folder boundary. Without a share or before
 * the Host answers, every method is an identity, so the tree renders exactly
 * as the official browser.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, Dispatch, DragEvent, HTMLAttributes, ReactNode, SetStateAction } from 'react'
import clsx from 'clsx'
import { IconFolderCloseRegular, IconFolderOpenRegular, IconTriangleRightFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import type { ArchivedFilter, GroupNode, SessionNode, SessionOrderBy } from '../tree.ts'
import type { WorkspaceFolder } from '../../folders/types.ts'
import { foldersOf, type FolderBrowserShare, type FolderTranslate, type FolderView } from './service.ts'
import rowCss from '../rows/Rows.module.css'
import browserCss from '../rows/WorkspaceBrowser.module.css'
import css from './Folders.module.css'

/** Non-blank rows a folder shows before its "Show more" control. */
const FOLDER_WATERMARK_BASE = 5
/** Attention-bearing rows raise the watermark automatically up to this row. */
const FOLDER_WATERMARK_AUTO_MAX = 50

const EMPTY_VIEW: FolderView = { phase: 'loading', folders: [], members: {} }
const NO_COLLAPSED: readonly string[] = []
const idle = (): (() => void) => () => {}

/** The browser root's folder input: the share plus the selected Session order. */
export interface FolderTreeInput {
  readonly share: FolderBrowserShare
  readonly orderBy: SessionOrderBy
}

/** In-flight Session row drag, as SessionTree holds it. */
interface SessionDrag {
  accountKey: string
  sessionId: SessionId
  pinned: boolean
  over: { id: SessionId; half: 'before' | 'after' } | null
}

/** A row that takes a dragged Session on release: highlight class plus native drag handlers. */
export interface RowDropTarget {
  readonly className: string | undefined
  readonly handlers: Pick<HTMLAttributes<HTMLDivElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'>
}

/** SessionTree facts the folder layer reads and the setters it drives. */
interface FolderTreeOptions extends Pick<WorkspaceBrowserProps, 'renderFactorySlot' | 'useContextMenu' | 'useContextMenuTarget' | 't'> {
  input: FolderTreeInput | undefined
  /** Workspaces with the browser-projected complete Session order. */
  workspaces: readonly WorkspaceView[]
  archivedFilter: ArchivedFilter
  current: SessionId | undefined
  revealSessionId: SessionId | undefined
  drag: SessionDrag | null
  setDrag: Dispatch<SetStateAction<SessionDrag | null>>
  /** SessionTree's guard against committing one drag twice. */
  committed: { current: boolean }
  setSessionOrder: (accountKey: string, order: readonly string[]) => void
  /** Settle a user-driven row-count change without the entry fade, as SessionTree's own "Show more" does. */
  settleMotion: () => void
}

interface FolderSection {
  readonly folder: WorkspaceFolder
  /** Every visible member in the group's sectioned order. */
  readonly rows: readonly SessionNode[]
}

/** The last split, reused while its inputs keep their identity. */
interface SplitCache {
  groups: GroupNode[]
  view: FolderView
  filter: ArchivedFilter
  result: GroupNode[]
  sections: Map<string, readonly FolderSection[]>
}

/** The folder layer's per-render API for SessionTree. */
export interface FolderTree {
  /** Remove folder members from each group's Session rows; the removed rows render in folder sections. */
  split(groups: GroupNode[]): GroupNode[]
  /** Row keys of the group's folder sections, in DOM order. */
  rowKeys(group: GroupNode): string[]
  /** The group's folder sections followed by its remaining Session rows. */
  render(group: GroupNode, depth: number, rows: readonly SessionNode[], renderRow: (node: SessionNode) => ReactNode): ReactNode[]
  /** The Workspace row's drop target while a Session from one of its folders is dragged. */
  headerDrop(group: GroupNode): RowDropTarget | undefined
  /** Apply a between-rows drop that involves a folder member; false leaves the drop to the official order. */
  commitDrop(group: GroupNode, order: readonly SessionId[], drag: SessionDrag, over: NonNullable<SessionDrag['over']>): boolean
}

/** Rows within the watermark, and how many it hides. */
function watermarkRows(rows: readonly SessionNode[], watermark: number): { rows: readonly SessionNode[]; hiddenCount: number } {
  const shown = rows.slice(0, watermark)
  return { rows: shown, hiddenCount: rows.length - shown.length }
}

/** Smallest watermark showing every attention-bearing row within the automatic maximum, and the reveal target. */
function requiredWatermark(rows: readonly SessionNode[], current: SessionId | undefined, reveal: SessionId | undefined): number {
  let required = 0
  rows.forEach((row, index) => {
    const attention = index < FOLDER_WATERMARK_AUTO_MAX && (
      row.running || row.runningSubagentCount > 0 || row.pendingInteraction !== undefined || row.completed || row.id === current
    )
    if (attention || row.id === reveal) required = index + 1
  })
  return required
}

/**
 * Folder layer state and rendering for one SessionTree.
 * @param options - SessionTree facts and setters.
 * @returns the per-render folder API.
 */
export function useFolderTree(options: FolderTreeOptions): FolderTree {
  const { input, workspaces, archivedFilter, current, revealSessionId, drag, setDrag, committed, setSessionOrder, settleMotion } = options
  const share = input?.share
  const view = useSyncExternalStore(share?.state.subscribe ?? idle, share?.state.getSnapshot ?? (() => EMPTY_VIEW))
  const storedCollapsed: unknown = useSyncExternalStore(
    share?.collapsed.subscribe ?? idle, share?.collapsed.getSnapshot ?? (() => NO_COLLAPSED),
  )
  const collapsedIds = Array.isArray(storedCollapsed) ? storedCollapsed as readonly string[] : NO_COLLAPSED
  const [marks, setMarks] = useState<Readonly<Record<string, number>>>({})
  const [dropKey, setDropKey] = useState<string | null>(null)
  const cache = useRef<SplitCache | null>(null)
  const sections = useRef(new Map<string, readonly FolderSection[]>())
  const active = share !== undefined && view.phase === 'ready'

  // A drag that ends or moves onto a Session row leaves no row highlighted.
  const markerActive = drag?.over !== null && drag?.over !== undefined
  useEffect(() => {
    if (drag === null || markerActive) setDropKey(null)
  }, [drag, markerActive])

  // Search navigation into a folded folder unfolds it so the row can scroll into view.
  const revealFolder = revealSessionId === undefined ? undefined : view.members[revealSessionId]
  useEffect(() => {
    if (share === undefined || revealFolder === undefined || !collapsedIds.includes(revealFolder)) return
    if (view.folders.some(folder => folder.id === revealFolder)) share.setCollapsed(revealFolder, false)
  }, [share, revealFolder, collapsedIds, view.folders])

  const folderIdsOf = (group: GroupNode): ReadonlySet<string> => new Set(group.cwd === undefined
    ? []
    : view.folders.filter(folder => folder.workspacePath === group.cwd).map(folder => folder.id))
  /** The folder of `group` holding a Session, by the rendered state. */
  const folderIn = (group: GroupNode, sessionId: SessionId): string | undefined => {
    const folderId = view.members[sessionId]
    return folderId !== undefined && folderIdsOf(group).has(folderId) ? folderId : undefined
  }
  const orderOf = (group: GroupNode): readonly SessionId[] | undefined =>
    workspaces.find(workspace => workspace.workspaceId === group.key)?.sessionIds

  const split = (groups: GroupNode[]): GroupNode[] => {
    if (!active) {
      sections.current = new Map()
      return groups
    }
    const cached = cache.current
    if (cached !== null && cached.groups === groups && cached.view === view && cached.filter === archivedFilter) {
      sections.current = cached.sections
      return cached.result
    }
    const next = new Map<string, readonly FolderSection[]>()
    const result = groups.map((group) => {
      if (group.workspaceId === undefined || group.cwd === undefined || !group.expanded) return group
      const folders = foldersOf(view.folders, group.cwd)
      if (folders.length === 0) return group
      const buckets = new Map<string, SessionNode[]>(folders.map(folder => [folder.id, []]))
      const loose: SessionNode[] = []
      for (const session of group.sessions) {
        const bucket = session.blank ? undefined : buckets.get(view.members[session.id] ?? '')
        if (bucket === undefined) loose.push(session)
        else bucket.push(session)
      }
      next.set(group.key, folders
        .map(folder => ({ folder, rows: buckets.get(folder.id) ?? [] }))
        // The archived-only view lists archives, so a folder without one is dropped like a Workspace.
        .filter(section => archivedFilter !== 'only' || section.rows.length > 0))
      return { ...group, sessions: loose }
    })
    sections.current = next
    cache.current = { groups, view, filter: archivedFilter, result, sections: next }
    return result
  }

  const layout = (section: FolderSection) => {
    const expanded = !collapsedIds.includes(section.folder.id)
    const baseline = Math.max(FOLDER_WATERMARK_BASE, requiredWatermark(section.rows, current, revealSessionId))
    const stored = marks[section.folder.id] ?? FOLDER_WATERMARK_BASE
    // Rows raised into view by activity stay in view, as the Workspace watermark does.
    if (expanded && baseline > stored) {
      const id = section.folder.id
      setMarks(value => baseline > (value[id] ?? FOLDER_WATERMARK_BASE) ? { ...value, [id]: baseline } : value)
    }
    const watermark = Math.max(stored, baseline)
    return { expanded, baseline, watermark, visible: watermarkRows(section.rows, watermark), folded: watermarkRows(section.rows, baseline) }
  }

  /** Release the drag into a folder, or out of every folder with null; Manual order puts the Session first there. */
  const dropInto = (group: GroupNode, folderId: string | null): void => {
    const source = drag
    committed.current = true
    setDrag(null)
    setDropKey(null)
    if (share === undefined || source === null || source.accountKey !== group.key) return
    if ((folderIn(group, source.sessionId) ?? null) === folderId) return
    const order = orderOf(group)
    const peers = order?.filter(id => id !== source.sessionId && (folderIn(group, id) ?? null) === folderId
      && group.sessions.find(row => row.id === id)?.blank !== true) ?? []
    share.move(source.sessionId, folderId)
    if (input?.orderBy !== 'manual' || order === undefined || peers[0] === undefined) return
    const next = order.filter(id => id !== source.sessionId)
    next.splice(next.indexOf(peers[0]), 0, source.sessionId)
    setSessionOrder(group.key, next)
  }

  const dropTarget = (group: GroupNode, key: string, folderId: string | null, changes: boolean): RowDropTarget => ({
    className: dropKey === key && changes ? css.dropTarget : undefined,
    handlers: {
      onDragOver: (event: DragEvent<HTMLDivElement>) => {
        // Releasing here must not commit the insertion marker last shown on a Session row.
        setDrag(state => state === null || state.over === null ? state : { ...state, over: null })
        if (!changes) {
          // The Session is already here: refuse the drop, and keep the browser's
          // document-wide acceptance from offering it anyway.
          event.stopPropagation()
          event.dataTransfer.dropEffect = 'none'
          return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (dropKey !== key) setDropKey(key)
      },
      onDragLeave: (event: DragEvent<HTMLDivElement>) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
        setDropKey(value => value === key ? null : value)
      },
      onDrop: (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault()
        dropInto(group, folderId)
      },
    },
  })

  const sameAccount = (group: GroupNode): boolean => active && drag !== null && drag.accountKey === group.key

  const renderSection = (
    group: GroupNode, depth: number, section: FolderSection, renderRow: (node: SessionNode) => ReactNode,
  ): ReactNode => {
    const { folder } = section
    const { expanded, visible, folded, watermark } = layout(section)
    const allShown = visible.hiddenCount === 0
    const drop = sameAccount(group)
      ? dropTarget(group, `folder:${folder.id}`, folder.id, drag !== null && folderIn(group, drag.sessionId) !== folder.id)
      : undefined
    return (
      <div
        key={`folder:${folder.id}`}
        role="group"
        className={css.section}
        style={{ '--dsh-workspace-indent': `${(depth + 1) * 12}px` } as CSSProperties}
      >
        <FolderRow
          folder={folder}
          expanded={expanded}
          active={current !== undefined && section.rows.some(row => row.id === current)}
          drop={drop}
          onToggle={() => {
            if (expanded && marks[folder.id] !== undefined) {
              setMarks(({ [folder.id]: _dropped, ...rest }) => rest)
              settleMotion()
            }
            share?.setCollapsed(folder.id, expanded)
          }}
          renderFactorySlot={options.renderFactorySlot}
          useContextMenu={options.useContextMenu}
          useContextMenuTarget={options.useContextMenuTarget}
          t={share?.t}
        />
        {expanded && visible.rows.map(renderRow)}
        {expanded && folded.hiddenCount > 0 && (
          <button
            type="button"
            className={clsx(browserCss.sessionOverflowButton, css.overflow)}
            data-row-key={`folder-overflow:${folder.id}`}
            aria-expanded={allShown}
            onClick={() => {
              settleMotion()
              if (allShown) {
                setMarks(({ [folder.id]: _dropped, ...rest }) => rest)
                return
              }
              setMarks(value => ({
                ...value,
                [folder.id]: visible.hiddenCount <= FOLDER_WATERMARK_BASE ? Infinity : watermark + FOLDER_WATERMARK_BASE,
              }))
            }}
          >
            {allShown ? options.t('sessions.collapse') : options.t('sessions.expand', { n: visible.hiddenCount })}
          </button>
        )}
      </div>
    )
  }

  return {
    split,
    rowKeys: (group) => {
      const keys: string[] = []
      for (const section of sections.current.get(group.key) ?? []) {
        keys.push(`folder:${section.folder.id}`)
        const { expanded, visible, folded } = layout(section)
        if (!expanded) continue
        for (const row of visible.rows) keys.push(`session:${row.id}`)
        if (folded.hiddenCount > 0) keys.push(`folder-overflow:${section.folder.id}`)
      }
      return keys
    },
    // The selected blank New Session row stays first, above the folders; AnimatedRows reads positions from the DOM.
    render: (group, depth, rows, renderRow) => [
      ...rows.filter(row => row.blank).map(renderRow),
      ...(sections.current.get(group.key) ?? []).map(section => renderSection(group, depth, section, renderRow)),
      ...rows.filter(row => !row.blank).map(renderRow),
    ],
    headerDrop: (group) => {
      if (!sameAccount(group) || drag === null || folderIn(group, drag.sessionId) === undefined) return undefined
      return dropTarget(group, `workspace:${group.key}`, null, true)
    },
    commitDrop: (group, order, source, over) => {
      if (!active || share === undefined) return false
      const from = folderIn(group, source.sessionId)
      const to = folderIn(group, over.id)
      if (from === undefined && to === undefined) return false
      const next = order.filter(id => id !== source.sessionId)
      const at = next.indexOf(over.id)
      if (at === -1) return true
      next.splice(at + (over.half === 'after' ? 1 : 0), 0, source.sessionId)
      if (from !== to) share.move(source.sessionId, to ?? null)
      else {
        // Within one folder, as the official reorder: no change unless the row moves among the shown rows of its block.
        const section = sections.current.get(group.key)?.find(candidate => candidate.folder.id === to)
        const block = (section === undefined ? [] : layout(section).visible.rows).filter(row => row.pinned === source.pinned)
        const sourceIndex = block.findIndex(row => row.id === source.sessionId)
        const others = block.filter(row => row.id !== source.sessionId)
        const insertAt = others.findIndex(row => row.id === over.id) + (over.half === 'after' ? 1 : 0)
        if (sourceIndex === -1 || insertAt === sourceIndex) return true
      }
      setSessionOrder(group.key, next)
      return true
    },
  }
}

/** One folder header: the Workspace row's look one level deeper, with its own menu and drop target. */
function FolderRow({
  folder, expanded, active, drop, onToggle, renderFactorySlot, useContextMenu, useContextMenuTarget, t,
}: Pick<WorkspaceBrowserProps, 'renderFactorySlot' | 'useContextMenu' | 'useContextMenuTarget'> & {
  folder: WorkspaceFolder
  expanded: boolean
  /** The folder holds the selected Session. */
  active: boolean
  drop: RowDropTarget | undefined
  onToggle: () => void
  t: FolderTranslate | undefined
}) {
  const { getTriggerProps } = useContextMenu()
  const target = {
    kind: 'workspaceFolder' as const,
    value: { folderId: folder.id, workspacePath: folder.workspacePath, name: folder.name },
  }
  const menuOpen = useContextMenuTarget(open => open?.kind === 'workspaceFolder' && open.value.folderId === folder.id)
  return (
    <div
      className={clsx(rowCss.projectRow, menuOpen && rowCss.menuOpen, drop?.className)}
      data-row-key={`folder:${folder.id}`}
      role="treeitem"
      aria-expanded={expanded}
      aria-description={t?.('folder.aria')}
      onClick={onToggle}
      {...getTriggerProps(target, { onKeyDown: (event) => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        event.preventDefault()
        onToggle()
      } })}
      {...drop?.handlers}
    >
      <span className={clsx(rowCss.slot, rowCss.folder, active && rowCss.folderActive)}>
        {expanded ? <IconFolderOpenRegular /> : <IconFolderCloseRegular />}
      </span>
      <span className={clsx(rowCss.slot, rowCss.chevron)}>
        <IconTriangleRightFillRegular className={clsx(rowCss.arrow, expanded && rowCss.arrowOpen)} />
      </span>
      <span className={rowCss.projectText}>
        <span className={rowCss.title}>{folder.name}</span>
      </span>
      <span className={rowCss.rowActions}>
        {renderFactorySlot('contextMenu.button', {
          target,
          label: t === undefined ? folder.name : t('folder.actions.aria', { name: folder.name }),
          className: rowCss.iconButton,
        })}
      </span>
    </div>
  )
}
