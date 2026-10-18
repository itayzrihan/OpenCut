/** A stable opening screen shared by account, project and editor initialization. */
export function WorkspaceLoading() {
	return (
		<main
			className="bg-background text-foreground fixed inset-0 z-40 grid place-items-center p-6"
			role="status"
			aria-live="polite"
			aria-busy="true"
			aria-label="Opening OpenCut"
		>
			<div className="w-full max-w-sm text-center">
				<div aria-hidden="true" className="mb-7 flex justify-center gap-1.5">
					<div className="bg-primary/20 h-12 w-4 rounded-md" />
					<div className="bg-primary/50 h-12 w-9 rounded-md" />
					<div className="bg-primary h-12 w-16 rounded-md motion-safe:animate-pulse" />
					<div className="bg-primary/30 h-12 w-7 rounded-md" />
				</div>
				<p className="text-2xl font-semibold tracking-tight">OpenCut</p>
				<h1 className="mt-3 text-sm font-medium">Opening your workspace</h1>
				<p className="text-muted-foreground mt-2 text-sm">
					Getting everything ready for your next edit.
				</p>
				<div
					aria-hidden="true"
					className="bg-muted mx-auto mt-7 h-1 w-40 overflow-hidden rounded-full"
				>
					<div className="bg-primary/60 h-full w-full rounded-full motion-safe:animate-pulse" />
				</div>
			</div>
		</main>
	);
}
