import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

const slash = (value) => value.replaceAll("\\", "/");
const sorted = (values) => [...new Set(values)].sort();
const production = (file) =>
	!/(?:^|\/)(?:__tests__|test-support|node_modules|generated)\//.test(
		slash(file),
	) && !/\.(?:test|spec|d)\.[cm]?[jt]sx?$/.test(file);

// AST leaves retain strings, regexes and template whitespace, but not trivia.
// No source printer or raw-text whitespace removal can safely do both.
export function fingerprint(nodes) {
	const hash = createHash("sha256");
	const visit = (node) => {
		if (ts.isJSDoc(node)) return;
		hash.update(`${node.kind}:`);
		const children = node.getChildren(node.getSourceFile());
		if (children.length === 0) hash.update(JSON.stringify(node.getText()));
		else children.forEach(visit);
		hash.update(";");
	};
	nodes.forEach(visit);
	return hash.digest("hex");
}

export function scanEditor({ configPath, sourceRoot, commandBasePath }) {
	sourceRoot = path.resolve(sourceRoot);
	commandBasePath = path.resolve(commandBasePath);
	const config = ts.readConfigFile(configPath, ts.sys.readFile);
	if (config.error)
		throw new Error(
			ts.flattenDiagnosticMessageText(config.error.messageText, "\n"),
		);
	const parsed = ts.parseJsonConfigFileContent(
		config.config,
		ts.sys,
		path.dirname(configPath),
	);
	if (parsed.errors.length)
		throw new Error(
			ts.formatDiagnosticsWithColorAndContext(parsed.errors, {
				getCurrentDirectory: () => process.cwd(),
				getCanonicalFileName: (f) => f,
				getNewLine: () => "\n",
			}),
		);
	const roots = ts.sys
		.readDirectory(sourceRoot, [
			".ts",
			".tsx",
			".mts",
			".cts",
			".js",
			".jsx",
			".mjs",
			".cjs",
		])
		.filter(production);
	const program = ts.createProgram(roots, {
		...parsed.options,
		incremental: false,
		noEmit: true,
	});
	const checker = program.getTypeChecker();
	const sources = program
		.getSourceFiles()
		.filter((file) =>
			roots.some((root) => path.resolve(root) === path.resolve(file.fileName)),
		);
	for (const source of sources) {
		if (source.parseDiagnostics.length)
			throw new Error(`Cannot inventory invalid syntax: ${source.fileName}`);
	}
	const location = (node) => ({
		file: slash(path.relative(sourceRoot, node.getSourceFile().fileName)),
		line:
			node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line +
			1,
	});
	const rootSource = sources.find(
		(source) => path.resolve(source.fileName) === commandBasePath,
	);
	const base = rootSource?.statements.find(
		(node) => ts.isClassDeclaration(node) && node.name?.text === "Command",
	);
	if (!base)
		throw new Error(
			"Canonical legacy Command base was not found; refusing an empty baseline",
		);
	const derivesFromCommand = (node) => {
		const seen = new Set();
		const visit = (type) => {
			if (!type || seen.has(type)) return false;
			seen.add(type);
			if (type.symbol?.declarations?.includes(base)) return true;
			return (type.getBaseTypes?.() ?? []).some(visit);
		};
		const type = checker.getTypeAtLocation(node);
		return (
			visit(type) ||
			type
				.getConstructSignatures()
				.some((signature) => visit(signature.getReturnType()))
		);
	};
	const className = (node) =>
		node.name?.getText() ??
		(ts.isVariableDeclaration(node.parent)
			? node.parent.name.getText()
			: `<anonymous@${location(node).line}>`);
	const functionNodes = new Map();
	const classes = [];
	const classDeclarations = [];
	const actionDefinitions = [];
	const actionBindings = [];
	const uiEvents = [];
	const canonicalCalls = [];
	const mutationSites = [];
	const excludedImports = [];
	const siteCounts = new Map();
	const stableOwner = (node) => {
		const names = [];
		for (let current = node.parent; current; current = current.parent) {
			if (ts.isFunctionLike(current) && current.body) {
				const name = functionName(current);
				if (!name.startsWith("<callback@")) names.unshift(name);
			}
		}
		return names.join("/") || "<module>";
	};
	const recordMutation = (node, target) => {
		const loc = location(node);
		const hash = fingerprint([node]);
		const key = `${loc.file}#${stableOwner(node)}#${target}#${hash}`;
		const ordinal = (siteCounts.get(key) ?? 0) + 1;
		siteCounts.set(key, ordinal);
		mutationSites.push({
			...loc,
			id: `${key}#${ordinal}`,
			target,
			fingerprint: hash,
		});
	};
	const inspectImport = (node, specifier) => {
		if (!specifier || !ts.isStringLiteralLike(specifier)) return;
		const resolved = ts.resolveModuleName(
			specifier.text,
			node.getSourceFile().fileName,
			parsed.options,
			ts.sys,
		).resolvedModule;
		if (!resolved) return;
		const destination = slash(path.resolve(resolved.resolvedFileName));
		const relative = slash(
			path.relative(path.dirname(sourceRoot), resolved.resolvedFileName),
		);
		if (
			!relative.startsWith("../") &&
			/(?:^|\/)(?:__tests__|test-support)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(
				destination,
			)
		)
			excludedImports.push({
				...location(node),
				specifier: specifier.text,
				destination: relative,
			});
	};
	const unwrap = (node) => {
		while (
			node &&
			(ts.isAsExpression(node) ||
				ts.isSatisfiesExpression(node) ||
				ts.isParenthesizedExpression(node))
		)
			node = node.expression;
		return node;
	};
	const symbolDeclarations = (node) => {
		let symbol = checker.getSymbolAtLocation(node);
		if (symbol?.flags & ts.SymbolFlags.Alias)
			symbol = checker.getAliasedSymbol(symbol);
		return symbol?.declarations ?? [];
	};
	const functionName = (node) => {
		if (
			ts.isMethodDeclaration(node) ||
			ts.isGetAccessor(node) ||
			ts.isSetAccessor(node)
		) {
			return `${node.parent.name?.getText() ?? "<object>"}.${node.name.getText()}`;
		}
		return (
			node.name?.getText() ??
			(ts.isVariableDeclaration(node.parent)
				? node.parent.name.getText()
				: `<callback@${location(node).line}:${node.pos}>`)
		);
	};
	const visit = (node) => {
		if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
			inspectImport(node, node.moduleSpecifier);
		if (
			ts.isImportEqualsDeclaration(node) &&
			ts.isExternalModuleReference(node.moduleReference)
		)
			inspectImport(node, node.moduleReference.expression);
		if (ts.isNewExpression(node)) {
			for (const declaration of symbolDeclarations(node.expression)) {
				if (
					(ts.isClassDeclaration(declaration) ||
						ts.isClassExpression(declaration)) &&
					derivesFromCommand(declaration)
				)
					recordMutation(
						node,
						`new:${location(declaration).file}#${className(declaration)}`,
					);
			}
		}
		if (ts.isClassDeclaration(node) || ts.isClassExpression(node))
			classDeclarations.push({ ...location(node), name: className(node) });
		if (
			(ts.isClassDeclaration(node) || ts.isClassExpression(node)) &&
			derivesFromCommand(node)
		) {
			const imports = node
				.getSourceFile()
				.statements.filter(
					(statement) =>
						ts.isImportDeclaration(statement) ||
						ts.isImportEqualsDeclaration(statement),
				);
			classes.push({
				...location(node),
				name: className(node),
				fingerprint: fingerprint([...imports, node]),
				base: node === base,
			});
		}
		if (ts.isFunctionLike(node) && node.body) {
			const loc = location(node);
			functionNodes.set(node, {
				...loc,
				name: functionName(node),
				calls: new Set(),
				capabilities: new Set(),
				legacyCommands: new Set(),
			});
		}
		if (
			ts.isVariableDeclaration(node) &&
			node.name.getText() === "ACTIONS" &&
			location(node).file === "actions/definitions.ts"
		) {
			const object = unwrap(node.initializer);
			if (object && ts.isObjectLiteralExpression(object))
				for (const prop of object.properties) {
					if (!ts.isPropertyAssignment(prop)) continue;
					const fields = unwrap(prop.initializer);
					const get = (key) =>
						fields && ts.isObjectLiteralExpression(fields)
							? fields.properties.find(
									(p) => ts.isPropertyAssignment(p) && p.name.getText() === key,
								)?.initializer
							: undefined;
					actionDefinitions.push({
						...location(prop),
						id: ts.isStringLiteral(prop.name)
							? prop.name.text
							: prop.name.getText(),
						description: get("description")?.text ?? null,
						category: get("category")?.text ?? null,
					});
				}
		}
		if (ts.isCallExpression(node)) {
			if (
				node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require")
			)
				inspectImport(node, node.arguments[0]);
			if (
				ts.isPropertyAccessExpression(node.expression) ||
				ts.isElementAccessExpression(node.expression)
			) {
				const property = ts.isPropertyAccessExpression(node.expression)
					? node.expression.name
					: node.expression.argumentExpression;
				const name = ts.isStringLiteralLike(property)
					? property.text
					: property.getText();
				const generic = [
					"updateTracks",
					"updateSceneTracks",
					"setActiveProject",
					"synchronizeProject",
					"synchronizeMedia",
				].includes(name);
				const legacyExecute =
					name === "execute" &&
					symbolDeclarations(property).some(
						(d) => location(d).file === "core/managers/commands.ts",
					);
				if (generic || legacyExecute) recordMutation(node, `call:${name}`);
			}
			const declarations = symbolDeclarations(
				ts.isPropertyAccessExpression(node.expression)
					? node.expression.name
					: node.expression,
			);
			const binding = declarations.find(
				(d) =>
					["useActionHandler", "bindAction"].includes(d.name?.getText()) &&
					slash(d.getSourceFile().fileName).includes("/actions/"),
			);
			if (binding)
				actionBindings.push({
					...location(node),
					action: ts.isStringLiteral(node.arguments[0] ?? base)
						? node.arguments[0].text
						: null,
					expression: node.arguments[0]?.getText(),
					handler: node.arguments[1],
				});
			// Candidate literals are only taken at this adapter's call sites. They are
			// evidence of wiring, never proof of feature parity or host availability.
			if (
				location(node).file === "core/canonical-classic-session.ts" &&
				ts.isPropertyAccessExpression(node.expression) &&
				node.expression.expression.kind === ts.SyntaxKind.ThisKeyword
			) {
				const object = node.arguments[0];
				const prop =
					object && ts.isObjectLiteralExpression(object)
						? object.properties.find(
								(p) =>
									ts.isPropertyAssignment(p) &&
									p.name.getText() === "capability",
							)
						: undefined;
				if (prop && ts.isStringLiteral(prop.initializer))
					canonicalCalls.push({
						node,
						capability: prop.initializer.text,
						...location(node),
					});
			}
		}
		if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
			const isCanonicalControl = symbolDeclarations(node.tagName).some(
				(declaration) =>
					declaration.name?.getText() === "CanonicalButton" &&
					location(declaration).file ===
						"components/editor/canonical-button.tsx",
			);
			if (isCanonicalControl) {
				const attribute = node.attributes.properties.find(
					(prop) => ts.isJsxAttribute(prop) && prop.name.getText() === "action",
				);
				const action =
					attribute?.initializer && ts.isJsxExpression(attribute.initializer)
						? unwrap(attribute.initializer.expression)
						: null;
				const property =
					action && ts.isObjectLiteralExpression(action)
						? action.properties.find(
								(prop) =>
									ts.isPropertyAssignment(prop) &&
									prop.name.getText() === "capabilityId",
							)
						: null;
				if (property && ts.isStringLiteral(property.initializer))
					canonicalCalls.push({
						node,
						capability: property.initializer.text,
						...location(node),
					});
			}
		}
		if (ts.isJsxAttribute(node) && /^on[A-Z]/.test(node.name.getText()))
			uiEvents.push({
				...location(node),
				event: node.name.getText(),
				handler:
					node.initializer && ts.isJsxExpression(node.initializer)
						? node.initializer.expression
						: undefined,
			});
		ts.forEachChild(node, visit);
	};
	sources.forEach(visit);
	const owner = (node) => {
		for (let current = node.parent; current; current = current.parent)
			if (functionNodes.has(current)) return current;
		return null;
	};
	for (const call of canonicalCalls)
		functionNodes.get(owner(call.node))?.capabilities.add(call.capability);
	const resolveFunctions = (expression) => {
		expression = unwrap(expression);
		if (!expression) return [];
		if (functionNodes.has(expression)) return [expression];
		return symbolDeclarations(
			ts.isPropertyAccessExpression(expression) ? expression.name : expression,
		).flatMap((d) => {
			if (functionNodes.has(d)) return [d];
			if (ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d)) {
				const initializer = unwrap(d.initializer);
				if (functionNodes.has(initializer)) return [initializer];
			}
			return [];
		});
	};
	const graphVisit = (node) => {
		const entry = functionNodes.get(owner(node));
		// A callback supplied to a transaction/wrapper may be invoked indirectly.
		// Include its lexical body as a candidate path, without claiming execution.
		if (entry && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
			entry.calls.add(node);
		}
		if (entry && ts.isCallExpression(node))
			for (const callee of resolveFunctions(node.expression))
				entry.calls.add(callee);
		if (entry && ts.isNewExpression(node)) {
			for (const d of symbolDeclarations(node.expression))
				if (
					(ts.isClassDeclaration(d) || ts.isClassExpression(d)) &&
					derivesFromCommand(d)
				)
					entry.legacyCommands.add(`${location(d).file}#${className(d)}`);
		}
		ts.forEachChild(node, graphVisit);
	};
	sources.forEach(graphVisit);
	const evidence = (starts) => {
		const seen = new Set();
		const capabilities = new Set();
		const commands = new Set();
		const walk = (node) => {
			if (seen.has(node)) return;
			seen.add(node);
			const entry = functionNodes.get(node);
			if (!entry) return;
			entry.capabilities.forEach((id) => capabilities.add(id));
			entry.legacyCommands.forEach((id) => commands.add(id));
			entry.calls.forEach(walk);
		};
		starts.forEach(walk);
		const infrastructure = (id) =>
			id.startsWith("project.classic.session.") ||
			[
				"project.classic.attach",
				"project.classic.commit",
				"project.classic.synchronize",
				"app.state.patch",
			].includes(id);
		return {
			candidateCapabilities: sorted(
				[...capabilities].filter((id) => !infrastructure(id)),
			),
			infrastructureCapabilities: sorted(
				[...capabilities].filter(infrastructure),
			),
			legacyCommands: sorted(commands),
			parityVerified: false,
		};
	};
	const describeHandler = ({ handler, ...data }) => ({
		...data,
		handlerResolved: resolveFunctions(handler).length > 0,
		...evidence(resolveFunctions(handler)),
	});
	const byLocation = (a, b) => a.file.localeCompare(b.file) || a.line - b.line;
	return {
		schemaVersion: 1,
		limitations: [
			"Static reachability is a candidate map, not verified migration status or runtime availability.",
			"Lexically nested callback bodies are included as possible paths, even when their wrapper may not invoke them.",
			"Dynamic dispatch, callbacks passed through wrappers, external effects and JSX spreads can be unresolved. A discovered path is not proof all branches use it.",
			"Generic Classic commit/synchronize and app.state.patch do not prove feature-specific agent coverage.",
			"The migration gates freeze legacy classes and known generic/legacy mutation call sites, and reject production imports of excluded fixtures. Arbitrary object writes, computed method names and helper body changes still require broader enforcement.",
		],
		sourceFiles: sources.length,
		classDeclarations: classDeclarations.sort(byLocation),
		legacyCommands: classes.sort(byLocation),
		mutationSites: mutationSites.sort(byLocation),
		excludedImports: excludedImports.sort(byLocation),
		canonicalCallSites: canonicalCalls
			.map(({ node: _node, ...data }) => data)
			.sort(byLocation),
		managerMethods: [...functionNodes.entries()]
			.filter(
				([node, data]) =>
					/^core\/managers\/[^/]+\.ts$/.test(data.file) &&
					(ts.isMethodDeclaration(node) ||
						ts.isGetAccessor(node) ||
						ts.isSetAccessor(node)),
			)
			.map(([node, data]) => ({
				file: data.file,
				line: data.line,
				name: data.name,
				...evidence([node]),
			}))
			.sort(byLocation),
		actions: actionDefinitions.sort(byLocation),
		actionBindings: actionBindings.map(describeHandler).sort(byLocation),
		uiEvents: uiEvents.map(describeHandler).sort(byLocation),
	};
}

/** Ratchet the existing generic mutation entry points while migration continues.
 * This catches new/changed legacy call sites, not arbitrary JS object writes. */
export function checkMutationBoundary(inventory, baseline) {
	if (
		baseline.schemaVersion !== 1 ||
		!baseline.sites ||
		typeof baseline.sites !== "object"
	)
		throw new Error("Invalid mutation-site baseline");
	return [
		...inventory.excludedImports.map(
			(entry) =>
				`${entry.file}:${entry.line}: production imports excluded test code (${entry.specifier})`,
		),
		...inventory.mutationSites.flatMap((entry) => {
			const previous = baseline.sites[entry.id];
			if (!previous)
				return [
					`${entry.file}:${entry.line} (${entry.id}): new generic/legacy mutation entry; invoke a canonical feature contract`,
				];
			if (previous !== entry.fingerprint)
				return [
					`${entry.file}:${entry.line} (${entry.id}): generic/legacy mutation call changed; migrate it or review the exception`,
				];
			return [];
		}),
	];
}

export function checkLegacyCommands(inventory, baseline) {
	if (
		baseline.schemaVersion !== 1 ||
		!baseline.commands ||
		typeof baseline.commands !== "object"
	)
		throw new Error("Invalid legacy-command baseline");
	const violations = [];
	const current = new Set(
		inventory.legacyCommands.map(
			(command) => `${command.file}#${command.name}`,
		),
	);
	const declarations = new Set(
		inventory.classDeclarations.map(
			(command) => `${command.file}#${command.name}`,
		),
	);
	for (const id of Object.keys(baseline.commands)) {
		if (!current.has(id) && declarations.has(id))
			violations.push(
				`${id}: legacy ancestry no longer resolves; review the migration instead of treating this as a deletion`,
			);
	}
	for (const command of inventory.legacyCommands) {
		const id = `${command.file}#${command.name}`;
		const previous = baseline.commands[id];
		if (!previous)
			violations.push(
				`${id}: new legacy command; implement the feature in the canonical capability registry`,
			);
		else if (previous !== command.fingerprint)
			violations.push(
				`${id}: legacy command or imports changed; migrate it or explicitly review the migration exception`,
			);
	}
	return violations;
}
