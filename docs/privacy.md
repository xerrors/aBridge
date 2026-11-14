# aBridge for Browser Privacy Policy

Last updated: November 15, 2026

aBridge for Browser connects the browser Profile where you install it to an aBridge Server that you choose. It lets Agents that you authorize observe and operate task pages in that browser.

## Data and destinations

The extension sends its device identity, connection status and capability information to your configured Server. When an authorized Agent requests a browser operation, the extension may send the task page's URL, title, visible text, interactive element information, action results and, when requested, a screenshot through that Server to the Agent. Page content may contain personal or sensitive information. Only authorize Agents and Servers you trust with that content.

The extension creates task tabs in the current Profile. Websites in those tabs use that Profile's existing login sessions under the browser's normal rules. There is no dedicated cookie or browser password database export tool. Protected password-field values are excluded from fixed observations. Authorized code can execute JavaScript inside task pages, read page-accessible data and make requests under the website session; observation filtering does not limit that code or make page text and screenshots free of sensitive information.

The project does not configure a developer-operated collection endpoint, advertising SDK or analytics service in the extension. Data goes to the Server you configure and the Agents you authorize, and websites receive ordinary browser requests when task pages are loaded or operated. The people operating those services control their own handling and retention of the data they receive.

## Local storage and retention

Chrome extension local storage holds the Server address, device name and identity, Device Key, pause state, operation receipt metadata and connection diagnostics. The Device Key authenticates this browser device. During binding, the extension opens the configured Server’s sign-in and consent page using a browser-managed authorization window. The extension does not read or store the management password; it exchanges a one-time authorization code bound with PKCE for its Device Key.

Operation receipts help prevent an interrupted action from being repeated. Connection diagnostics record connection events and error codes. They are not a page-browsing history or an analytics feed. This version does not offer a timed automatic deletion policy for all receipt metadata.

The supplied Server implementation keeps device, grant, session, operation and audit metadata in its database. Operation results may be cached temporarily in Server memory for retrieval; database records do not store screenshot or page bodies. A Server operator or Agent may separately retain information after receiving it.

## Permissions

- `debugger`: inspect task-page structure, prepare rendering for native input, and capture requested screenshots using fixed extension code.
- `tabs`: create, navigate and close extension-owned task tabs and associate them with the correct control session.
- `storage`: retain the device binding, local controls and receipt metadata.
- `identity`: open the Server's authorization page and receive the extension's authorization callback.
- Optional `identity.email`: requested only when you click “使用 Profile 账户”. Once granted, the extension can read the current Profile's account email to suggest a device name; it does not request a Google OAuth token. You can edit the suggested name before binding. The final device name, including the email if you keep it, is sent to the Server you choose when registering the device.
- `alarms`: attempt reconnection when the browser is running.
- Optional host access: contact the Server origin you enter during registration. The extension asks for that origin when you bind it.

Authorized browser code runs in an isolated JavaScript engine on your Server and can call task-page actions, read snapshots and evaluate page JavaScript. Raw debugging commands are not exposed to Agents. Code state and snapshots are held in bounded memory and cleared with their owning sessions.

## Your controls

Pause access or stop current tasks from the extension's toolbar popup. Reconnection does not clear a pause. Unbinding disables the local binding and, while connected, sends a revocation request to the Server; verify or complete revocation in the Server management console. Uninstalling the extension removes its extension storage under Chrome's normal behavior. Existing Server or Agent records are managed by the operators of those services and are not deleted merely by uninstalling the extension. You can revoke Agent access and browser devices in the Server management console.

## Contact and changes

For questions about this extension, use the [project issue tracker](https://github.com/xerrors/aBridge/issues). Do not post passwords, keys or private page contents in public issues. Contact your Server or Agent operator for records they retain. Changes to this policy will be published in this document with an updated date.
