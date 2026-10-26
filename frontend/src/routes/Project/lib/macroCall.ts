// Adapter packages other adapters build on: their macros live in dbt's
// global namespace even when the project's own adapter is different.
const BASE_ADAPTER_PACKAGES = new Set(['dbt_postgres', 'dbt_spark']);

function isInternalPackage(pkg: string, adapterType: string): boolean {
  return pkg === 'dbt' || pkg === `dbt_${adapterType}` || BASE_ADAPTER_PACKAGES.has(pkg);
}

/** The name to call a macro by from the root project: macros from installed
 *  packages (dbt_utils, …) need their package namespace; the root project's own
 *  and dbt's built-in macros are global. */
export function macroCallName(
  name: string,
  packageName: string | null,
  projectName: string,
  adapterType: string,
): string {
  if (!packageName || packageName === projectName || isInternalPackage(packageName, adapterType)) {
    return name;
  }
  return `${packageName}.${name}`;
}

export function buildMacroCall(callName: string, argValues: Record<string, string>): string {
  const args = Object.entries(argValues);
  if (args.length === 0) return `${callName}()`;
  const lines = args.map(([k, v]) => `    ${k}=${v || "''"}`).join(',\n');
  return `${callName}(\n${lines}\n)`;
}

export function wrapJinja(call: string): string {
  return `{{ ${call.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()} }}`;
}
