/** Folder create, rename, and delete dialogs, keyed by their captured request. */
import { useRef, useState, useSyncExternalStore } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { FOLDER_NAME_MAX_LENGTH, type WorkspaceFolder } from '../../folders/types.ts'
import { FolderCallError, foldersOf, type FolderBrowserShare, type FolderDialogRequest } from './service.ts'
import css from '../rows/WorkspaceBrowser.module.css'

/**
 * Render the requested folder dialog, or nothing.
 * @param props.share - the folder share holding the request and the Host changes.
 * @returns the open dialog, or null.
 */
export function FolderDialogs({ share }: { share: FolderBrowserShare }) {
  const request = useSyncExternalStore(fn => share.dialog.subscribe(fn), () => share.dialog.getSnapshot())
  if (request === null) return null
  const key = request.kind === 'create' ? `create/${request.workspacePath}/${request.sessionId ?? ''}` : `${request.kind}/${request.folder.id}`
  return request.kind === 'delete'
    ? <DeleteFolder key={key} folder={request.folder} share={share} />
    : <NameFolder key={key} request={request} share={share} />
}

/** Message of a refused change, with the duplicate-name refusal in the reader's language. */
function failureText(share: FolderBrowserShare, reason: unknown, name: string): string {
  console.warn('workspace folders: change rejected', reason)
  if (!(reason instanceof FolderCallError)) return share.t('notice.failed')
  switch (reason.code) {
    case 'workspaceFolders/duplicate': return share.t('folder.duplicate', { name })
    case 'workspaceFolders/not-found': return share.t('notice.notFound')
    case 'workspaceFolders/invalid': return share.t('notice.invalid')
    case 'workspaceFolders/unavailable': return share.t('notice.unavailable')
    default: return share.t('notice.failed')
  }
}

/** Create or rename: one name field, checked against the Workspace's other folders. */
function NameFolder({ request, share }: {
  request: Exclude<FolderDialogRequest, { kind: 'delete' }>
  share: FolderBrowserShare
}) {
  const { t } = share
  const renaming = request.kind === 'rename'
  const [draft, setDraft] = useState(renaming ? request.folder.name : '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const composing = useRef(false)
  const state = useSyncExternalStore(fn => share.state.subscribe(fn), () => share.state.getSnapshot())
  const workspacePath = renaming ? request.folder.workspacePath : request.workspacePath
  const name = draft.trim()
  const duplicate = name !== '' && foldersOf(state.folders, workspacePath)
    .some(folder => folder.name === name && (!renaming || folder.id !== request.folder.id))
  const tooLong = name.length > FOLDER_NAME_MAX_LENGTH
  const blocked = pending || name === '' || duplicate || tooLong || (renaming && name === request.folder.name)
  const close = (): void => {
    if (!pending) share.settleDialog()
  }
  const confirm = (): void => {
    if (blocked) return
    setPending(true)
    setError(null)
    const change = renaming
      ? share.rename(request.folder.id, name)
      : share.create(request, name)
    change.then(() => {
      setPending(false)
      share.settleDialog()
    }).catch((reason: unknown) => {
      setPending(false)
      setError(failureText(share, reason, name))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={renaming ? t('folder.rename.title') : t('folder.new')}
      {...renaming ? {} : { description: t('folder.create.desc') }}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={blocked} onClick={confirm}>
            {renaming ? t('folder.rename') : t('folder.create')}
          </Button>
        </>
      )}
    >
      <input
        className={css.renameInput}
        value={draft}
        aria-label={t('folder.field')}
        data-modal-autofocus
        disabled={pending}
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setDraft(e.target.value); setError(null) }}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !composing.current) {
            e.preventDefault()
            confirm()
          }
        }}
      />
      {duplicate && <div className={css.renameError} role="alert">{t('folder.duplicate', { name })}</div>}
      {tooLong && <div className={css.renameError} role="alert">{t('folder.tooLong', { n: FOLDER_NAME_MAX_LENGTH })}</div>}
      {error !== null && <div className={css.renameError} role="alert">{error}</div>}
    </Modal>
  )
}

/** Delete confirmation; the folder's Sessions stay in the Workspace. */
function DeleteFolder({ folder, share }: { folder: WorkspaceFolder; share: FolderBrowserShare }) {
  const { t } = share
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = (): void => {
    if (!pending) share.settleDialog()
  }
  const confirm = (): void => {
    if (pending) return
    setPending(true)
    setError(null)
    share.remove(folder.id).then(() => {
      setPending(false)
      share.settleDialog()
    }).catch((reason: unknown) => {
      setPending(false)
      setError(failureText(share, reason, folder.name))
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('folder.delete')}
      description={t('folder.delete.desc', { name: folder.name })}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
          <Button variant="outline" className={css.deleteAction} disabled={pending} onClick={confirm}>
            {t('folder.delete')}
          </Button>
        </>
      )}
    >
      {error !== null && <div className={css.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
