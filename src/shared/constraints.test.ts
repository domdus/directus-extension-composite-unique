import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fieldsMatch } from './config';
import { buildIndexName, creationOrderField, suggestFieldsForCollection } from './constraints';

test('long index names stay within the limit and stay distinct', () => {
	const a = buildIndexName('x'.repeat(80), ['one', 'two']);
	const b = buildIndexName('x'.repeat(80), ['one', 'three']);
	assert.equal(a.length <= 63, true);
	assert.notEqual(a, b);
});

test('creationOrderField finds the date-created field', () => {
	const schema = {
		collections: {
			a: { fields: { id: { field: 'id' }, made: { field: 'made', special: ['date-created'] } } },
			b: { fields: { id: { field: 'id' } } },
		},
	};
	assert.equal(creationOrderField(schema, 'a'), 'made');
	assert.equal(creationOrderField(schema, 'b'), null);
});

test('suggestions skip system relations', () => {
	const schema = {
		collections: { j: { primary: 'id', fields: {} } },
		relations: [
			{ collection: 'j', field: 'a_id', related_collection: 'a' },
			{ collection: 'j', field: 'user_created', related_collection: 'directus_users' },
			{ collection: 'j', field: 'image', related_collection: 'directus_files' },
		],
	};
	assert.deepEqual(suggestFieldsForCollection(schema, 'j'), ['a_id']);
});

test('fieldsMatch ignores order', () => {
	assert.equal(fieldsMatch(['a', 'b'], ['b', 'a']), true);
	assert.equal(fieldsMatch(['a', 'b'], ['a', 'c']), false);
});
