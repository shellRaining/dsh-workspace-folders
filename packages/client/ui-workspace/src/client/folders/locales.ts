/** `workspaceFolders` namespace dictionaries: folder rows, menus, dialogs, and notices. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'folder.new': '新建文件夹',
  'folder.newSession': '新建会话',
  'folder.newEllipsis': '新建文件夹…',
  'folder.create': '创建',
  'folder.create.desc': '文件夹只用于整理侧栏，不会在磁盘上创建目录。',
  'folder.rename.title': '重命名文件夹',
  'folder.rename': '重命名',
  'folder.delete': '删除文件夹',
  'folder.delete.desc': '将删除文件夹“{name}”。其中的会话会回到文件夹外，不会被删除或归档。',
  'folder.field': '文件夹名称',
  'folder.duplicate': '已存在名为“{name}”的文件夹。',
  'folder.tooLong': '名称不能超过 {n} 个字符。',
  'folder.actions.aria': '文件夹“{name}”的操作',
  'menu.moveToFolder': '移动到文件夹',
  'menu.removeFromFolder': '移出文件夹',
  'folder.aria': '文件夹',
  'notice.moved': '已移动到“{name}”',
  'notice.movedOut': '已移出“{name}”',
  'notice.moveFailed': '无法移动会话，请重试',
  'notice.notFound': '这个文件夹已不存在，列表已刷新。',
  'notice.invalid': '名称不能为空，也不能过长。',
  'notice.failed': '操作没有完成，请重试。',
  'notice.unavailable': '工作区文件夹暂时不可用，请稍后重试',
} satisfies Record<string, string>

/** Every key of the namespace. */
export type WorkspaceFolderKey = keyof typeof zh

/** English dictionary. */
export const en = {
  'folder.new': 'New folder',
  'folder.newSession': 'New session',
  'folder.newEllipsis': 'New folder…',
  'folder.create': 'Create',
  'folder.create.desc': 'Folders only organize the sidebar. No directory is created on disk.',
  'folder.rename.title': 'Rename folder',
  'folder.rename': 'Rename',
  'folder.delete': 'Delete folder',
  'folder.delete.desc': 'This deletes the folder “{name}”. Its sessions move out of the folder; none is deleted or archived.',
  'folder.field': 'Folder name',
  'folder.duplicate': 'A folder named “{name}” already exists.',
  'folder.tooLong': 'Names can be at most {n} characters.',
  'folder.actions.aria': 'Folder actions for {name}',
  'menu.moveToFolder': 'Move to folder',
  'menu.removeFromFolder': 'Remove from folder',
  'folder.aria': 'Folder',
  'notice.moved': 'Moved to “{name}”',
  'notice.movedOut': 'Removed from “{name}”',
  'notice.moveFailed': 'Could not move the session. Try again.',
  'notice.notFound': 'This folder no longer exists. The list has been refreshed.',
  'notice.invalid': 'Names cannot be blank or too long.',
  'notice.failed': 'The change did not go through. Try again.',
  'notice.unavailable': 'Workspace folders are unavailable. Try again later.',
} satisfies Record<WorkspaceFolderKey, string>
