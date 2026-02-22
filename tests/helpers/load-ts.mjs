import jitiFactory from 'jiti';

const jiti = jitiFactory(import.meta.url);

export function loadTs(modulePath) {
	return jiti(modulePath);
}
