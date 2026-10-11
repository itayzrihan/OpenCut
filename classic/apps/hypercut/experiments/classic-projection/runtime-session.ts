import { emptyProject, type Snapshot, type SessionView } from "./model";
export interface Runtime {
	invokeSync(
		id: string,
		input: unknown,
		context?: unknown,
	): { result: { data: any } };
	snapshot(): unknown;
	beginTransaction(projectId: string, revision: number): void;
	commitTransaction(label: string, context: unknown): unknown;
	rollbackTransaction(): void;
	free(): void;
}
export class RuntimeSession {
	constructor(
		readonly runtime: Runtime,
		readonly projectId: string,
	) {}
	call(id: string, input: unknown, context?: unknown): any {
		return this.runtime.invokeSync(id, input, context).result.data;
	}
	open(name: string, archive?: unknown) {
		if (archive)
			this.call("project.classic.session.restore", {
				projectId: this.projectId,
				expectedRevision: 0,
				archive,
			});
		else
			this.call("project.classic.session.attach", {
				projectId: this.projectId,
				expectedRevision: 0,
				classic: emptyProject(this.projectId, name),
				undoStack: [],
				redoStack: [],
			});
	}
	snapshot(): Snapshot {
		return this.call("app.state.read", {}).value;
	}
	view(persisted = true): SessionView {
		return {
			snapshot: this.snapshot(),
			history: this.call("project.classic.session.status", {
				projectId: this.projectId,
			}),
			persisted,
		};
	}
	archive(): unknown {
		return this.call("project.classic.session.archive", {
			projectId: this.projectId,
			persistableOnly: true,
			compact: true,
			chained: true,
		});
	}
	invoke(
		capability: string,
		input: Record<string, unknown>,
		expectedRevision: number,
	) {
		// The UI must retain the revision from which its gesture was made. Never silently rebase a stale drag.
		if (capability === "history.undo" || capability === "history.redo")
			return this.call(
				capability,
				{},
				{
					metadata: {
						"opencut/projectId": this.projectId,
						"opencut/expectedRevision": expectedRevision,
					},
				},
			);
		return this.call(capability, {
			...input,
			projectId: this.projectId,
			expectedRevision,
		});
	}
}
