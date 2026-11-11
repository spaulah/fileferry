import { PROVIDER_LABELS, type ProviderKind } from './providers';
import type { Preset } from './presets';

interface DestinationProps {
  provider: ProviderKind;
  onProvider: (kind: ProviderKind) => void;
  mode: 'simulation' | 'live';
  onMode: (mode: 'simulation' | 'live') => void;
  presets: Preset[];
  presetId: string;
  onPreset: (id: string) => void;
  siteUrl: string;
  onSiteUrl: (value: string) => void;
  token: string;
  onToken: (value: string) => void;
}

const PLATFORM_NOTES: Record<ProviderKind, string> = {
  graph: 'Document libraries on a SharePoint site, or OneDrive through Microsoft Graph.',
  dropbox: 'Folders in a Dropbox account, through the Dropbox HTTP API.'
};

const MODE_NOTES: Record<'simulation' | 'live', { title: string; note: string }> = {
  simulation: {
    title: 'Simulated service',
    note: 'Runs in this browser. No account needed. Pick a failure to rehearse how the share copes.'
  },
  live: {
    title: 'My real account',
    note: 'Files and invitations go to your account. Needs an access token.'
  }
};

const TOKEN_HELP: Record<ProviderKind, string> = {
  graph:
    'A Microsoft Graph token with the Sites.ReadWrite.All permission. Graph Explorer can produce one for testing. Tokens expire after about an hour.',
  dropbox:
    'An access token from an app in the Dropbox App Console, with files.content.read, files.content.write and sharing.write. Development tokens expire.'
};

/** The first step of the share form: where the files go, and how the run is simulated or connected. */
export function Destination({
  provider,
  onProvider,
  mode,
  onMode,
  presets,
  presetId,
  onPreset,
  siteUrl,
  onSiteUrl,
  token,
  onToken
}: DestinationProps) {
  const platformLabel: string = PROVIDER_LABELS[provider];
  const selectedPreset: Preset | undefined = presets.find((candidate) => candidate.id === presetId);
  const missing: string[] = [];
  if (mode === 'live') {
    if (provider === 'graph' && siteUrl.trim() === '') {
      missing.push('the site address');
    }
    if (token.trim() === '') {
      missing.push('an access token');
    }
  }

  return (
    <section className="destination" aria-labelledby="destination-heading">
      <h2 id="destination-heading">3. Where it goes</h2>

      <fieldset className="choice-group">
        <legend>Platform</legend>
        <div className="choice-cards">
          {(Object.keys(PROVIDER_LABELS) as ProviderKind[]).map((kind) => (
            <label key={kind} className={`choice-card ${provider === kind ? 'on' : ''}`}>
              <input
                className="sr-only"
                type="radio"
                name="platform"
                value={kind}
                checked={provider === kind}
                onChange={() => {
                  onProvider(kind);
                }}
              />
              <span className="choice-title">{PROVIDER_LABELS[kind]}</span>
              <span className="choice-note">{PLATFORM_NOTES[kind]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="choice-group">
        <legend>How to run it</legend>
        <div className="choice-cards">
          {(['simulation', 'live'] as const).map((value) => (
            <label key={value} className={`choice-card ${mode === value ? 'on' : ''}`}>
              <input
                className="sr-only"
                type="radio"
                name="mode"
                value={value}
                checked={mode === value}
                onChange={() => {
                  onMode(value);
                }}
              />
              <span className="choice-title">{MODE_NOTES[value].title}</span>
              <span className="choice-note">{MODE_NOTES[value].note}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {mode === 'simulation' ? (
        <fieldset className="choice-group">
          <legend>What goes wrong, on {platformLabel}</legend>
          <div className="failure-grid">
            {presets.map((candidate) => (
              <label key={candidate.id} className={`failure-option ${presetId === candidate.id ? 'on' : ''}`}>
                <input
                  className="sr-only"
                  type="radio"
                  name="failure"
                  value={candidate.id}
                  checked={presetId === candidate.id}
                  onChange={() => {
                    onPreset(candidate.id);
                  }}
                />
                <span className="failure-dot" aria-hidden="true" />
                {candidate.label}
              </label>
            ))}
          </div>
          <p className="failure-note">{selectedPreset?.description}</p>
        </fieldset>
      ) : (
        <div className="connect">
          <h3>Connect to {platformLabel}</h3>
          <div className="stack">
            {provider === 'graph' && (
              <label className="field">
                <span>Site address</span>
                <input
                  placeholder="https://yourtenant.sharepoint.com/sites/shared"
                  value={siteUrl}
                  onChange={(event) => {
                    onSiteUrl(event.target.value);
                  }}
                />
                <span className="hint">The SharePoint site whose document library receives the files.</span>
              </label>
            )}
            <label className="field">
              <span>Access token</span>
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => {
                  onToken(event.target.value);
                }}
              />
              <span className="hint">{TOKEN_HELP[provider]} Kept in memory for this page only, never saved.</span>
            </label>
          </div>
          <p className={`status ${missing.length === 0 ? 'ok' : ''}`} role="status">
            {missing.length === 0
              ? `Ready to share with ${platformLabel}.`
              : `Still needed: ${missing.join(' and ')}.`}
          </p>
        </div>
      )}
    </section>
  );
}
