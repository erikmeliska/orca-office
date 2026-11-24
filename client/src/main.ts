import { PROTOCOL_VERSION } from '@orca-office/shared';

// Placeholder until the agent-office client is copied in (M1, #10).
const app = document.querySelector<HTMLDivElement>('#app');
if (app) app.textContent = `orca-office (protocol ${PROTOCOL_VERSION})`;
