/**
 * Conservative shell path preflight for agent-specific external-directory rules.
 * This is not a shell AST or a sandbox. Dynamic expansions cannot be resolved
 * here and must not be treated as internal paths.
 */
export function shellPathCandidates(command: string): { paths: string[]; dynamic: boolean } {
	// URLs are not local paths. A path in a shell argument may follow whitespace,
	// a quote, an assignment, or an opening bracket in inline code.
	const pattern = /(?:^|[\s"'=([{])((?:[a-zA-Z]:[\\/]|\/(?!\/)|~[\\/]|\.{1,2}[\\/]|file:\/\/)[^\s"'`|;&<>)}\]]+)/g;
	const paths = [...command.matchAll(pattern)].map((match) => match[1]);
	return {
		paths,
		// Shell variables, backticks and command substitutions can conceal paths.
		dynamic: /\$|`/.test(command),
	};
}
