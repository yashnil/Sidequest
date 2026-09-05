export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') {
    return { url: 'data:text/javascript,export default undefined;', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
