import { at } from './helpers.js';
import { describe, expect, it } from 'vitest';
import { planShare, ValidationError, type SelectedFile } from '../src/index.js';

const file = (name: string, size = 10): File => new File([new Uint8Array(size)], name);
const selected = (relativePath: string, size?: number): SelectedFile => ({
  file: file(relativePath.split('/').pop()!, size),
  relativePath
});

describe('planShare', () => {
  it('lays out case, audience, nested folders and uploads', () => {
    const plan = planShare({
      caseNumber: '2024-001',
      caseTitle: 'Smith v. Jones',
      audiences: [
        {
          name: 'Client',
          folderName: 'Client',
          files: [selected('Subpoena/response.pdf'), selected('loose.pdf')],
          folders: ['Subpoena', 'Subpoena/Empty'],
          recipients: 'Alice@Example.com'
        }
      ]
    });

    expect(plan.caseFolderPath).toBe('2024-001 - Smith v. Jones');
    expect(plan.folderPaths).toEqual([
      '2024-001 - Smith v. Jones',
      '2024-001 - Smith v. Jones/Client',
      '2024-001 - Smith v. Jones/Client/Subpoena',
      '2024-001 - Smith v. Jones/Client/Subpoena/Empty'
    ]);
    expect(plan.uploads.map((upload) => upload.targetPath)).toEqual([
      '2024-001 - Smith v. Jones/Client/Subpoena/response.pdf',
      '2024-001 - Smith v. Jones/Client/loose.pdf'
    ]);
    expect(plan.audiences[0]).toMatchObject({
      recipients: ['alice@example.com'],
      inviteSubject: 'Client folder access',
      access: 'write'
    });
  });

  it('skips audiences with nothing selected and no recipients', () => {
    const plan = planShare({
      caseTitle: 'Case',
      audiences: [
        { name: 'Client', folderName: 'Client', recipients: 'a@b.com' },
        { name: 'Opposing Counsel', folderName: 'Opposing Counsel' }
      ]
    });

    expect(plan.audiences.map((audience) => audience.name)).toEqual(['Client']);
    expect(plan.folderPaths).not.toContain('Case/Opposing Counsel');
  });

  it('rejects invalid email addresses across all audiences in one error', () => {
    expect(() =>
      planShare({
        caseTitle: 'Case',
        audiences: [
          { name: 'Client', folderName: 'Client', recipients: 'bad-one, a@b.com' },
          { name: 'Opposing', folderName: 'Opposing', recipients: 'also bad' }
        ]
      })
    ).toThrow(new ValidationError('Invalid email addresses: bad-one, also bad'));
  });

  it('rejects files for an audience with no recipient', () => {
    expect(() =>
      planShare({
        caseTitle: 'Case',
        audiences: [{ name: 'Client', folderName: 'Client', files: [selected('a.pdf')], recipients: '' }]
      })
    ).toThrow(/Add at least one valid email address for Client/);
  });

  it('requires at least one recipient somewhere', () => {
    expect(() => planShare({ caseTitle: 'Case', audiences: [{ name: 'Client', folderName: 'Client', folders: ['x'] }] })).toThrow(
      /at least one recipient/
    );
  });

  it('requires a case name', () => {
    expect(() => planShare({ caseTitle: '   ', audiences: [{ name: 'Client', folderName: 'Client', recipients: 'a@b.com' }] })).toThrow(
      /case title or case number/
    );
  });

  it('rejects two audiences that would share a folder name', () => {
    expect(() =>
      planShare({
        caseTitle: 'Case',
        audiences: [
          { name: 'Client', folderName: 'Shared', recipients: 'a@b.com' },
          { name: 'Other', folderName: 'shared', recipients: 'c@d.com' }
        ]
      })
    ).toThrow(/Two groups share/);
  });

  it('uses the requested access and subject when given', () => {
    const plan = planShare({
      caseTitle: 'Case',
      audiences: [{ name: 'Client', folderName: 'Client', recipients: 'a@b.com', access: 'read', inviteSubject: '  Review copies  ' }]
    });

    expect(at(plan.audiences, 0).access).toBe('read');
    expect(at(plan.audiences, 0).inviteSubject).toBe('Review copies');
  });
});
