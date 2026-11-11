import { useState } from 'react';
import {
  EMPTY_SELECTION,
  ShareClient,
  describeError,
  mergeSelections,
  planShare,
  type AudienceRequest,
  type FileSelection,
  type InviteAccess,
  type ProgressEvent,
  type ShareRequest,
  type ShareResult
} from '@fileferry/core';
import { Destination } from './Destination';
import { DropZone } from './DropZone';
import { CLEAN_PRESET, PRESETS, type Preset } from './presets';
import { PROVIDER_LABELS, liveProvider, simulate, type ProviderKind, type Simulation, type StoredItem } from './providers';
import { SCENARIOS, sampleSelection, type GroupTemplate, type Scenario } from './scenarios';

interface Group {
  id: number;
  name: string;
  access: InviteAccess;
  recipients: string;
  selection: FileSelection;
  sampleFiles: string[];
}

interface RunSummary {
  result: ShareResult;
  items: StoredItem[];
  requests: number;
  failedRequests: number;
  replacedFolders: number | undefined;
  provider: ProviderKind;
}

const lockedCopy = (file: File): File =>
  ({
    name: file.name,
    size: file.size,
    slice: () => ({
      arrayBuffer: () => Promise.reject(new DOMException('The file is open in another program.', 'NotReadableError'))
    })
  }) as unknown as File;

const groupsFrom = (templates: GroupTemplate[]): Group[] =>
  templates.map((template, index) => ({
    id: index + 1,
    name: template.name,
    access: template.access,
    recipients: template.recipients,
    selection: EMPTY_SELECTION,
    sampleFiles: template.sampleFiles
  }));

const initialScenario = SCENARIOS[0];

export function App() {
  const [scenarioId, setScenarioId] = useState<string>(initialScenario.id);
  const [recordNumber, setRecordNumber] = useState<string>(initialScenario.sampleNumber);
  const [recordTitle, setRecordTitle] = useState<string>(initialScenario.sampleTitle);
  const [groups, setGroups] = useState<Group[]>(() => groupsFrom(initialScenario.groups));
  const [nextId, setNextId] = useState<number>(initialScenario.groups.length + 1);

  const [mode, setMode] = useState<'simulation' | 'live'>('simulation');
  const [provider, setProvider] = useState<ProviderKind>('graph');
  const [presetId, setPresetId] = useState<string>('clean');
  const [liveSiteUrl, setLiveSiteUrl] = useState<string>('');
  const [token, setToken] = useState<string>('');

  const [preview, setPreview] = useState<string[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [running, setRunning] = useState<boolean>(false);
  const [log, setLog] = useState<ProgressEvent[]>([]);
  const [notifications, setNotifications] = useState<string[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const scenario: Scenario = SCENARIOS.find((candidate) => candidate.id === scenarioId) ?? initialScenario;
  const preset: Preset = PRESETS.find((candidate) => candidate.id === presetId) ?? CLEAN_PRESET;
  const word: string = scenario.recordWord;

  const clearResults = () => {
    setPreview(null);
    setPreviewError(null);
    setLog([]);
    setNotifications([]);
    setSummary(null);
    setRunError(null);
  };

  const chooseScenario = (next: Scenario) => {
    setScenarioId(next.id);
    setRecordNumber(next.sampleNumber);
    setRecordTitle(next.sampleTitle);
    setGroups(groupsFrom(next.groups));
    setNextId(next.groups.length + 1);
    clearResults();
  };

  const updateGroup = (id: number, change: Partial<Group>) => {
    setGroups((current) => current.map((group) => (group.id === id ? { ...group, ...change } : group)));
  };

  const buildRequest = (): ShareRequest => {
    const audiences: AudienceRequest[] = groups.map((group) => ({
      name: group.name,
      folderName: group.name,
      files: group.selection.files,
      folders: group.selection.folders,
      recipients: group.recipients,
      access: group.access,
      inviteSubject: `${group.name}: ${word} ${recordNumber}`
    }));

    return { caseNumber: recordNumber, caseTitle: recordTitle, audiences };
  };

  const runPreview = () => {
    setPreviewError(null);
    try {
      const plan = planShare(buildRequest());
      setPreview([
        `${word} folder: ${plan.caseFolderPath}`,
        `${plan.folderPaths.length} folder(s) will be created`,
        `${plan.uploads.length} file(s) will be uploaded`,
        ...plan.audiences.map(
          (audience) =>
            `${audience.name} (${audience.access === 'read' ? 'read only' : 'can edit'}): ${audience.recipients.length} invitation(s), ${audience.uploads.length} file(s)`
        )
      ]);
    } catch (error) {
      setPreview(null);
      setPreviewError(describeError(error));
    }
  };

  const runShare = async () => {
    setRunning(true);
    clearResults();

    const request = buildRequest();
    let simulation: Simulation | undefined;

    const onProgress = (event: ProgressEvent) => {
      setLog((current) => [...current, event]);
    };
    const onFoldersShared = ({ folderPath, invitedRecipients }: { folderPath: string; invitedRecipients: string[] }) => {
      setNotifications((current) => [
        ...current,
        `Notification queued for ${invitedRecipients.length} recipient(s) in ${folderPath}`
      ]);
    };

    try {
      if (mode === 'simulation') {
        simulation = simulate(provider, preset);

        if (preset.lockFirstFile) {
          const first = request.audiences.find((audience) => (audience.files?.length ?? 0) > 0);
          const [head, ...rest] = first?.files ?? [];
          if (first && head) {
            first.files = [{ ...head, file: lockedCopy(head.file) }, ...rest];
          }
        }
      }

      const client = new ShareClient({
        provider: simulation?.provider ?? liveProvider(provider, { siteUrl: liveSiteUrl, token }),
        onProgress,
        onFoldersShared
      });

      const result = await client.share(request);
      const requests = simulation?.requests() ?? { total: 0, failed: 0 };
      setSummary({
        result,
        items: simulation?.stored() ?? [],
        requests: requests.total,
        failedRequests: requests.failed,
        replacedFolders: simulation?.replacedFolders,
        provider
      });
    } catch (error) {
      setRunError(describeError(error));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>External Share</h1>
          <p className="muted">
            Share folders and files with people outside your organization through Microsoft Graph. This demo runs the
            real sharing engine. Pick a scenario for industry wording and sample files. By default it talks to an
            in-browser fakes of SharePoint and Dropbox, so you can try the hard cases without an account.
          </p>
        </div>
      </header>

      <div className="columns">
        <section className="panel">
          <h2>1. Scenario</h2>
          <div className="presets">
            {SCENARIOS.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={`preset ${scenarioId === candidate.id ? 'on' : ''}`}
                onClick={() => {
                  chooseScenario(candidate);
                }}
              >
                {candidate.label}
              </button>
            ))}
          </div>
          <p className="hint">{scenario.summary} Choosing a scenario resets the form.</p>

          <h2>2. {word}</h2>
          <div className="row">
            <label className="field">
              <span>{scenario.numberLabel}</span>
              <input
                value={recordNumber}
                onChange={(event) => {
                  setRecordNumber(event.target.value);
                }}
              />
            </label>
            <label className="field grow">
              <span>{scenario.titleLabel}</span>
              <input
                value={recordTitle}
                onChange={(event) => {
                  setRecordTitle(event.target.value);
                }}
              />
            </label>
          </div>

          <Destination
            provider={provider}
            onProvider={(kind) => {
              setProvider(kind);
              clearResults();
            }}
            mode={mode}
            onMode={setMode}
            presets={PRESETS}
            presetId={presetId}
            onPreset={setPresetId}
            siteUrl={liveSiteUrl}
            onSiteUrl={setLiveSiteUrl}
            token={token}
            onToken={setToken}
          />

          <h2>4. Who and what</h2>
          {groups.map((group) => (
            <div className="group" key={group.id}>
              <div className="row">
                <label className="field grow">
                  <span>Group name (also the folder name)</span>
                  <input
                    value={group.name}
                    onChange={(event) => {
                      updateGroup(group.id, { name: event.target.value });
                    }}
                  />
                </label>
                <label className="field">
                  <span>Access</span>
                  <select
                    value={group.access}
                    onChange={(event) => {
                      updateGroup(group.id, { access: event.target.value as InviteAccess });
                    }}
                  >
                    <option value="write">Can edit</option>
                    <option value="read">Read only</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setGroups((current) => current.filter((candidate) => candidate.id !== group.id));
                  }}
                  disabled={groups.length === 1}
                >
                  Remove
                </button>
              </div>
              <label className="field">
                <span>Recipients (commas, semicolons or new lines)</span>
                <textarea
                  rows={2}
                  value={group.recipients}
                  onChange={(event) => {
                    updateGroup(group.id, { recipients: event.target.value });
                  }}
                />
              </label>
              <DropZone
                selection={group.selection}
                onSelect={(incoming) => {
                  updateGroup(group.id, { selection: mergeSelections(group.selection, incoming) });
                }}
                onClear={() => {
                  updateGroup(group.id, { selection: EMPTY_SELECTION });
                }}
              />
              {group.sampleFiles.length > 0 && (
                <button
                  type="button"
                  className="ghost small-btn"
                  onClick={() => {
                    updateGroup(group.id, {
                      selection: mergeSelections(group.selection, sampleSelection(group.sampleFiles))
                    });
                  }}
                >
                  Add sample files
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setGroups((current) => [
                ...current,
                { id: nextId, name: 'New group', access: 'write', recipients: '', selection: EMPTY_SELECTION, sampleFiles: [] }
              ]);
              setNextId((current) => current + 1);
            }}
          >
            Add group
          </button>
        </section>

        <section className="panel">
          <h2>5. Check, then share</h2>
          <div className="row">
            <button type="button" className="ghost" onClick={runPreview} disabled={running}>
              Preview plan
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                void runShare();
              }}
              disabled={running}
            >
              {running ? 'Sharing…' : 'Share'}
            </button>
          </div>

          {previewError && <div className="alert error">{previewError}</div>}
          {preview && (
            <ul className="plan">
              {preview.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}

          {runError && <div className="alert error">{runError}</div>}

          {log.length > 0 && (
            <>
              <h3>Progress</h3>
              <ol className="log">
                {log
                  .filter((event) => event.status !== 'start')
                  .map((event, index) => (
                    <li key={index} className={`log-${event.status}`}>
                      <span className="phase">{event.phase}</span> {event.message}
                      {event.error && <div className="log-error">{event.error}</div>}
                    </li>
                  ))}
              </ol>
            </>
          )}

          {summary && (
            <>
              <h3>Result</h3>
              <p className="muted">
                {word} folder: <code>{summary.result.caseFolderPath}</code>
              </p>
              {summary.result.audiences.map((audience) => (
                <div className="audience-result" key={audience.folderPath}>
                  <strong>{audience.name}</strong> <code>{audience.folderPath}</code>
                  <ul>
                    {audience.invitations.map((invitation) => (
                      <li key={invitation.recipient} className={invitation.status === 'invited' ? 'ok' : 'bad'}>
                        {invitation.status === 'invited' ? 'Invited' : 'Not invited'} {invitation.recipient}
                        {invitation.error && <div className="log-error">{invitation.error}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {summary.result.warnings.map((warning) => (
                <div className="alert warn" key={warning}>
                  {warning}
                </div>
              ))}
              <p className="muted">
                {summary.requests} requests to the simulated service, {summary.failedRequests} got an error reply or a
                dropped connection (some are expected, such as 404s when checking whether a folder exists yet).
                {summary.replacedFolders !== undefined && (
                  <> Folders replaced by mistake: {summary.replacedFolders}.</>
                )}{' '}
                Files stored: {summary.items.filter((item) => !item.folder).length}.
              </p>
            </>
          )}

          {notifications.length > 0 && (
            <>
              <h3>Follow-up</h3>
              <ul className="plan">
                {notifications.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </>
          )}

          {summary && summary.items.length > 0 && (
            <>
              <h3>What {PROVIDER_LABELS[summary.provider]} now holds (simulated)</h3>
              <ul className="tree">
                {summary.items.map((item) => (
                  <li key={item.path}>
                    {item.folder ? '📁' : '📄'} {item.path}
                    {!item.folder && <span className="muted"> ({item.size} bytes)</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
