import type { FileSelection, InviteAccess } from '@fileferry/core';

// A scenario is only vocabulary and starting values. The engine does not change between
// them, which is the point: the same sharing logic serves any industry.

export interface GroupTemplate {
  name: string;
  access: InviteAccess;
  recipients: string;
  /** Names of sample files the demo can add to this group, for quick trials. */
  sampleFiles: string[];
}

export interface Scenario {
  id: string;
  label: string;
  /** One line shown under the scenario picker. */
  summary: string;
  /** What one shared package is called, e.g. "Matter" or "Work order". Used in headings and messages. */
  recordWord: string;
  numberLabel: string;
  titleLabel: string;
  sampleNumber: string;
  sampleTitle: string;
  groups: GroupTemplate[];
}

/** Non-empty, so the first scenario is always defined. */
export const SCENARIOS: readonly [Scenario, ...Scenario[]] = [
  {
    id: 'legal',
    label: 'Legal team',
    summary: 'Share matter files with the client, and exhibits with opposing counsel as read-only.',
    recordWord: 'Matter',
    numberLabel: 'Matter number',
    titleLabel: 'Matter title',
    sampleNumber: '2024-001',
    sampleTitle: 'Smith v. Jones',
    groups: [
      {
        name: 'Client',
        access: 'write',
        recipients: 'alice@example.com, bob@example.com',
        sampleFiles: ['Engagement letter.pdf', 'Subpoena response.pdf']
      },
      {
        name: 'Opposing Counsel',
        access: 'read',
        recipients: 'carol@opposing.example',
        sampleFiles: ['Exhibit A - Contract.pdf']
      }
    ]
  },
  {
    id: 'manufacturing',
    label: 'Manufacturing',
    summary: 'Send drawings and material certificates to a supplier, and inspection records to the customer.',
    recordWord: 'Work order',
    numberLabel: 'Work order no.',
    titleLabel: 'Job description',
    sampleNumber: 'WO-2026-0457',
    sampleTitle: 'Bracket assembly, Line 3',
    groups: [
      {
        name: 'Supplier',
        access: 'write',
        recipients: 'purchasing@supplier.example',
        sampleFiles: ['Drawing rev C.pdf', 'Material certificate.pdf']
      },
      {
        name: 'Customer quality',
        access: 'read',
        recipients: 'quality@customer.example',
        sampleFiles: ['Inspection report.xlsx', 'Certificate of conformance.pdf']
      }
    ]
  },
  {
    id: 'accounting',
    label: 'Accounting firm',
    summary: 'Exchange engagement workpapers with the client finance team and an outside tax advisor.',
    recordWord: 'Engagement',
    numberLabel: 'Engagement code',
    titleLabel: 'Client and period',
    sampleNumber: 'FY2025-AUD-014',
    sampleTitle: 'Northwind Traders, FY2025 audit',
    groups: [
      {
        name: 'Client finance',
        access: 'write',
        recipients: 'cfo@client.example',
        sampleFiles: ['Trial balance FY2025.xlsx', 'Bank statements Q4.pdf']
      },
      {
        name: 'Tax advisor',
        access: 'read',
        recipients: 'tax@advisor.example',
        sampleFiles: ['Tax provision draft.xlsx']
      }
    ]
  },
  {
    id: 'blank',
    label: 'Blank',
    summary: 'No industry wording. Start from scratch with a generic package and one group.',
    recordWord: 'Package',
    numberLabel: 'Reference',
    titleLabel: 'Title',
    sampleNumber: 'REF-001',
    sampleTitle: 'Shared package',
    groups: [{ name: 'Partner', access: 'write', recipients: '', sampleFiles: ['Document.pdf'] }]
  }
];

/** Builds in-memory files with the given names, for trying the demo without real documents. */
export const sampleSelection = (names: string[]): FileSelection => ({
  files: names.map((name) => ({ file: new File([`Sample content for ${name}\n`], name), relativePath: name })),
  folders: []
});
