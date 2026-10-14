import { block, file, joinBlocks, q } from '../format';

export function foldersTf() {
  const blocks = [];

  // Top-Level Folders under Organization
  blocks.push(
    block('resource "google_folder" "platform"', [
      ['display_name', q('Platform')],
      ['parent', q('organizations/\${var.organization_id}')],
    ])
  );

  blocks.push(
    block('resource "google_folder" "workloads"', [
      ['display_name', q('Workloads')],
      ['parent', q('organizations/\${var.organization_id}')],
    ])
  );

  // Subfolders for Environment Isolation
  blocks.push(
    block('resource "google_folder" "corp"', [
      ['display_name', q('Corp-Private')],
      ['parent', 'google_folder.workloads.name'],
    ])
  );

  blocks.push(
    block('resource "google_folder" "online"', [
      ['display_name', q('Online-PublicEdge')],
      ['parent', 'google_folder.workloads.name'],
    ])
  );

  return file('folders.tf', joinBlocks(blocks));
}
