import type { LegalEdition } from "./documents";

export const englishLegal = {
	draft: "Pre-release draft for review",
	development:
		"POCUT is under active development. The app has known bugs, and we continually work to fix them. Features, compatibility and reliability can vary by build.",
	contents: "On this page",
	documents: {
		privacy: {
			title: "Privacy policy",
			description:
				"How POCUT handles account information, project files and data sent to connected services.",
			sections: {
				"scope-and-operator": {
					heading: "Scope and who handles your data",
					paragraphs: [
						"This policy covers the POCUT website, video editor and related account services in the deployment operated for POCUT. If you use a separate self-hosted installation, its operator controls that deployment and may use different hosting, storage and logging settings. Connected services may process information under their own policies.",
						"The production policy will identify the legal operator, its address and a private contact for data requests. During the private preview, use the private contact through which you received access, or contact your installation administrator.",
					],
				},
				"information-we-handle": {
					heading: "What we handle and why",
					items: [
						"Accounts and sign-in. We use an account identifier, display name, session information and, for local accounts where enabled, a login name and password verifier. For Legitate sign-in, we use a verified identity identifier to link your POCUT account and validate your session. Legitate handles credentials and authentication on its service. We use account information to grant access, keep workspaces separate and protect accounts.",
						"Projects and settings. The editor may save source media, timelines, thumbnails, captions, exports, Brand Kit assets, agent conversations and preferences in the workspace. Depending on installation, data may be in browser storage, the installation's account vault, or storage you select. The browser and desktop editor can perform many edits and some transcription locally.",
						"Technical and support data. Hosting and security infrastructure may handle network identifiers such as IP addresses, request times, browser information and operational logs. We use this data to deliver and secure the service, troubleshoot faults and respond to requests. When you ask for help, we process the contact details and materials you choose to send.",
					],
					paragraphs: [
						"You choose whether to provide optional information or enable integrations. Sign-in information is needed for account access. Media and prompts are needed only for the actions that use them. If you withhold required information, the corresponding account function or optional feature may be unavailable. If you include information about other people, make sure you have the authority and any permissions needed for your use of it.",
					],
				},
				"external-ai": {
					heading: "AI providers and connected accounts",
					paragraphs: [
						"When you use an external AI feature, POCUT sends the material needed for that request. This can include prompts, reference images, attachments, selected frames, audio, transcripts, relevant project context and technical or job metadata. The provider may return outputs or status information that POCUT saves in your workspace. An agent can use the material or context available to its enabled tools.",
						"Depending on the feature and settings, recipients can include OpenAI through a connected ChatGPT or Codex account, OpenRouter and the model provider it routes to, or another endpoint you configure. The connection may use a token or API key. Retention, logging, use for model improvement and available controls depend on the provider, account type and settings. Review those controls before sending client footage, private information or confidential files. Use local options where available if the material must stay in your installation.",
					],
				},
				"devices-and-storage": {
					heading: "Cross-device transfers and backups",
					paragraphs: [
						"If you enable a saved-version destination, encrypted snapshots can be written to your chosen drive, shared folder or provider-managed folder. The destination operator handles its own access, file metadata and copies. Keep track of where you placed snapshots and who has access.",
						"When peer sync is enabled, the relay uses Legitate identity and device or connection metadata to show eligible devices as online. When you request a transfer, it routes encrypted messages and queues them temporarily in memory. A completed transfer creates a copy on the receiving device. Copies on other devices, in exports or in external backups must be managed separately.",
					],
				},
				"cookies-and-telemetry": {
					heading: "Cookies, browser storage and diagnostics",
					paragraphs: [
						"POCUT uses session and connection cookies for sign-in and connected accounts. A standard POCUT account session has a seven-day maximum lifetime, unless ended earlier. Browser storage, including IndexedDB or local storage, may hold workspace data and preferences. Clearing it can remove local work or require sign-in again. It does not erase files from the installation's vault or from backups.",
						"Databuddy telemetry is off by default in the code. If the deployment enables it, the site can send visit and error diagnostics to Databuddy. Optional tracking in a public deployment is subject to applicable notice, consent and choice requirements.",
					],
				},
				"legal-bases-and-recipients": {
					heading: "Legal bases, disclosures and transfers",
					paragraphs: [
						"Where the GDPR or comparable rules apply, we rely on performance of the service contract for essential account functions and requested processing, legitimate interests in security, troubleshooting and responding to inquiries where those interests are not overridden by your rights, compliance with legal obligations, or consent where required. You can withdraw consent for future processing without affecting lawful processing that already occurred.",
						"Depending on the deployment, information may be disclosed to hosting, security and support providers; the identity, storage and AI services used for a feature; a payment processor if purchases are offered; or competent authorities where law requires disclosure. If purchases are enabled, the checkout notice will explain the payment processor and the billing information used to administer purchases, invoices and refunds.",
						"Connected providers and infrastructure may process data outside your country. Where transfer rules apply, the operator must use a valid legal basis for the transfer and appropriate protections, such as a recognized adequacy decision or approved contractual safeguards where relevant. You may ask the operator about the safeguards for your deployment.",
					],
				},
				"retention-and-security": {
					heading: "Retention and security",
					paragraphs: [
						"Workspace data stays in the relevant browser, vault or storage destination until removed under its applicable settings. Account and connection information is kept while needed to operate the account. Support records and technical logs are kept as needed to address the issue, protect the service or comply with law. Legal obligations, disputes or security incidents may require longer retention. Third-party copies follow the recipient's retention rules.",
						"Account controls, encrypted backup and relay paths, and other safeguards reduce risk. Keep your devices, credentials, storage destinations and recovery material secure. If you suspect account misuse or accidental disclosure, report it privately.",
					],
				},
				rights: {
					heading: "Your rights and choices",
					paragraphs: [
						"Under Israeli law you may have rights to inspect personal information held about you and request correction or deletion of information that is incorrect, incomplete, unclear or outdated. Depending on where you live and what law applies, you may also have rights to access, correct, delete, restrict or object to processing, obtain a portable copy, withdraw consent, or complain to a supervisory authority.",
						"Use the private preview contact or your installation administrator to make a request. We may verify your identity before releasing or changing information. For copies controlled by a connected provider or another installation, you may also need to contact that operator. POCUT is not directed to children. Report suspected child account data through the same private channel.",
					],
				},
				changes: {
					heading: "Changes to this policy",
					paragraphs: [
						"The published version will show its effective date. If our handling of information changes materially, we will explain the change and provide notice or request consent where required.",
					],
				},
			},
		},
		terms: {
			title: "Terms of use",
			description:
				"Conditions for using POCUT, keeping control of your work and connecting external AI services.",
			sections: {
				"service-and-account": {
					heading: "Service, account and eligibility",
					paragraphs: [
						"These terms cover the hosted POCUT service and its account features. The published version will identify the contracting operator. Source code and separately licensed components remain subject to their applicable licenses. If you use POCUT for an organization, you must have authority to act for it. Use the service only if you can lawfully enter into the agreement.",
						"Keep your device, account and connected provider credentials secure. Use only accounts, memberships and keys you are authorized to use. Tell the operator promptly through your private preview contact if you suspect misuse. Where local sign-in is available, protect the local credentials and any recovery files.",
					],
				},
				"preview-and-known-bugs": {
					heading: "Active development and known bugs",
					paragraphs: [
						"Known bugs can affect editing, saving, synchronization, preview, rendering and export. A preview can differ from the exported file. Work can become temporarily inaccessible, or an operation can fail partway. Keep copies of your source files, save or export project backups regularly, and inspect the final export before delivery or publication.",
						"We continually investigate issues and ship fixes. An experimental feature or a particular provider integration may change or be unavailable. This notice does not take away statutory guarantees, remedies or other rights that apply to you.",
					],
				},
				"your-content": {
					heading: "Your content, rights and licenses",
					paragraphs: [
						"You retain the rights you hold in your source files, projects and exports. When you use an operation that processes your material, you authorize the handling reasonably needed to carry it out, including storage, rendering or transmission to a provider or device you select. POCUT does not obtain an ownership interest in your work from that authorization.",
						"You are responsible for having rights and permissions for footage, music, fonts, templates, likenesses and other material you use. Stock assets, models, examples and third-party material can carry separate licenses and attribution or commercial-use limits. Check those terms before using the material in client work, advertising or distribution.",
					],
				},
				"external-ai": {
					heading: "AI generation, agents and provider costs",
					paragraphs: [
						"External AI features may require your own API key or a supported membership. Provider quotas, eligibility, usage policies and charges are governed by your provider agreement and may change. External AI usage is billed separately from POCUT. A request may be counted or billed by the provider even if generation fails, is cancelled late or does not return the desired result.",
						"Review an agent's edits, changes to the timeline and generated results before relying on them. Outputs may be inaccurate, similar to another user's results, or subject to third-party rights. POCUT does not guarantee exclusivity, copyright protection, clearance or fitness for publication. Check privacy, likeness rights and any required synthetic-media disclosure before publishing.",
					],
				},
				"plans-and-cancellation": {
					heading: "Plans, payment and cancellation",
					paragraphs: [
						"The preview describes a free tier and a proposed POCUT Pro plan at US$5. This draft does not set a billing interval or authorize a charge. Before purchase is enabled, the offer and checkout will state the total price, currency, taxes where applicable, billing period, whether it renews, how to cancel and the refund or withdrawal rules.",
						"If you purchase a plan once checkout is available, the terms disclosed at purchase apply alongside mandatory rights. Where consumer law grants cancellation, withdrawal, refund, repair or other rights, those rights apply. Cancelling POCUT does not cancel a subscription you bought directly from an external provider.",
					],
				},
				"acceptable-use": {
					heading: "Acceptable use and reports",
					items: [
						"Use POCUT lawfully and respect copyright, privacy, confidentiality, publicity and other rights.",
						"Do not use it to create or distribute unlawful material, sexual exploitation, non-consensual intimate imagery, fraud or deceptive impersonation, or to harass or threaten others.",
						"Do not gain unauthorized access, introduce malware, interfere with the service or bypass access or billing controls. Lawful use of separately licensed source code is governed by that license.",
					],
					paragraphs: [
						"Report security, rights or abuse concerns privately through the preview administrator. Include enough detail to identify the issue and the remedy sought, without sending passwords, keys or unnecessary personal information.",
					],
				},
				"changes-and-ending-access": {
					heading: "Changes, suspension and ending access",
					paragraphs: [
						"We may update the service to fix bugs, improve security, adapt to provider or technical changes, or comply with law. For material changes affecting a paid service or these terms, we will give advance notice where required and honor any applicable rights to end the service or obtain a remedy.",
						"We may suspend access when reasonably necessary to protect the service or other users, address a material violation, or comply with law. Where feasible and lawful we will explain the reason and offer a way to respond or resolve it. You may stop using the service. Export important work before ending access. Applicable rights to retrieve your data or content continue to apply.",
					],
				},
				"consumer-rights": {
					heading: "Liability, consumer rights and disputes",
					paragraphs: [
						"To the extent permitted by law, preview features are offered as available. We do not promise uninterrupted operation, preservation of every edit or compatibility with every device or file format. Nothing in these terms excludes or limits liability that cannot lawfully be excluded or limited, or restricts mandatory guarantees, data protection rights or consumer remedies.",
						"You may contact the operator to seek a resolution and may use any court, regulator or dispute process available to you under applicable law. An invalid provision will be limited or severed to the extent permitted, without removing rights that the law protects. The published terms will identify the operator, effective date and contact for formal notices.",
					],
				},
			},
		},
		accessibility: {
			title: "Accessibility statement",
			description:
				"Our accessibility goals, limitations you may encounter and how to request help.",
			sections: {
				"standards-and-status": {
					heading: "Scope and current status",
					paragraphs: [
						"This statement covers the POCUT website, web editor and desktop experience where offered. We use WCAG 2.2 Level AA as a design and testing target and will assess any applicable local requirements, including Israeli Standard 5568 and the service accessibility regulations for an Israeli release.",
						"Full conformance has not been established. An assessment of the complete editor and desktop experience is pending. Accessibility defects are part of ongoing development and remediation.",
					],
				},
				"using-pocut": {
					heading: "Using POCUT with assistive technology",
					items: [
						"The legal pages include a skip link, descriptive headings, visible keyboard focus, and navigation by section. You can use Tab and Shift+Tab to move through links and controls.",
						"The editor provides keyboard shortcuts for several common editing tasks. Check the keyboard shortcuts dialog for the commands available in your version.",
						"Where supported by your browser or operating system, use its zoom, text and display settings. If enlargement hides a control or makes a task difficult, tell us which screen and control were affected.",
					],
				},
				limitations: {
					heading: "Areas that may present barriers",
					items: [
						"Some timeline gestures, including clip dragging, resizing or precise scrubbing, may lack an equivalent keyboard or assistive-technology path.",
						"Canvas previews, waveforms, and some real-time statuses or visual changes may not have a complete text equivalent. Automated captions can contain errors and may need editing.",
						"Third-party sign-in, provider screens, and imported or generated media have varying accessibility. Some combinations of browser, operating system and assistive technology may behave differently.",
					],
				},
				"feedback-and-assistance": {
					heading: "Report a barrier or request an alternative",
					paragraphs: [
						"Use the private contact through which you received preview access, or contact your installation administrator. Tell us which page or feature you were using, the task you were trying to complete, your browser or app version, and the assistive technology involved if you are comfortable sharing it. Say how we can reach you and whether you need an alternative format or a way to complete a time-sensitive task.",
						"Please leave out medical details, passwords and private footage. We will review reports and look for a workaround or an accessible alternative where feasible. The published statement will list the designated contact and the arrangements relevant to the release.",
					],
				},
			},
		},
	},
} satisfies LegalEdition;
