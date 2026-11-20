import { describe, expect, it } from 'vitest';
import type { GraphDto, ModelNode } from '../../../../lib/api';
import { findYamlTargetRange, yamlTargetFor } from './yamlTarget';

const SCHEMA = `version: 2

models:
  - name: customers
    description: one row per customer
    columns:
      - name: customer_id
        tests:
          - unique
          - not_null
      - name: email
        description: contact

  - name: orders
    columns:
      - name: order_id
        tests:
          - unique
          - relationships:
              to: ref('customers')
              field: customer_id

sources:
  - name: raw
    tables:
      - name: orders
        columns:
          - name: id
      - name: payments

metrics:
- name: revenue
  type: simple
  type_params:
    measure: amount
- description: count of orders
  name: order_count
  type: simple

unit_tests:
  - name: orders_state
    model: orders
    given: []
`;

const range = (t: Parameters<typeof findYamlTargetRange>[1]) => findYamlTargetRange(SCHEMA, t);

describe('findYamlTargetRange', () => {
  it('covers a whole model entry, stopping before the next one', () => {
    expect(range({ kind: 'entry', section: 'models', name: 'customers' })).toEqual({ start: 4, end: 12 });
    expect(range({ kind: 'entry', section: 'models', name: 'orders' })).toEqual({ start: 14, end: 21 });
  });

  it('finds a column inside its model, not a same-named column elsewhere', () => {
    expect(range({ kind: 'entry', section: 'models', name: 'customers', column: 'email' })).toEqual({ start: 11, end: 12 });
  });

  it('falls back to the entry when the column is missing', () => {
    expect(range({ kind: 'entry', section: 'models', name: 'customers', column: 'nope' })).toEqual({ start: 4, end: 12 });
  });

  it('finds a source table under its source, not the model of the same name', () => {
    expect(range({ kind: 'entry', section: 'tables', name: 'orders', parent: { section: 'sources', name: 'raw' } }))
      .toEqual({ start: 26, end: 28 });
    expect(range({ kind: 'entry', section: 'tables', name: 'payments', parent: { section: 'sources', name: 'raw' } }))
      .toEqual({ start: 29, end: 29 });
  });

  it('handles a list at its key indent and `name:` that is not the first key', () => {
    expect(range({ kind: 'entry', section: 'metrics', name: 'revenue' })).toEqual({ start: 32, end: 35 });
    expect(range({ kind: 'entry', section: 'metrics', name: 'order_count' })).toEqual({ start: 36, end: 38 });
  });

  it('covers a test with its arguments', () => {
    expect(range({ kind: 'test', testMetadataName: 'relationships', columnName: 'order_id', attachedNode: 'model.p.orders' }))
      .toEqual({ start: 19, end: 21 });
    expect(range({ kind: 'test', testMetadataName: 'not_null', columnName: 'customer_id', attachedNode: 'model.p.customers' }))
      .toEqual({ start: 10, end: 10 });
  });

  it('covers a unit test entry', () => {
    expect(range({ kind: 'unit_test', name: 'orders_state' })).toEqual({ start: 41, end: 43 });
  });

  it('returns null for something not in the file', () => {
    expect(range({ kind: 'entry', section: 'models', name: 'missing' })).toBeNull();
    expect(range({ kind: 'entry', section: 'tables', name: 'orders', parent: { section: 'sources', name: 'other' } })).toBeNull();
  });
});

const node = (over: Partial<ModelNode>): ModelNode => ({
  unique_id: '', name: '', resource_type: 'model', schema_: null, database: null, materialized: null, tags: [],
  description: '', original_file_path: null, source_name: null, status: 'idle', message: null, columns: [],
  test_metadata_name: null, column_name: null, attached_node: null, patch_path: null, ...over,
});

const GRAPH: GraphDto = {
  nodes: [
    node({ unique_id: 'model.p.orders', name: 'orders' }),
    node({ unique_id: 'source.p.raw.orders', name: 'orders', resource_type: 'source', source_name: 'raw' }),
    node({ unique_id: 'metric.p.revenue', name: 'revenue', resource_type: 'metric' }),
    node({ unique_id: 'test.p.unique_orders_order_id', resource_type: 'test', test_metadata_name: 'unique', column_name: 'order_id', attached_node: 'model.p.orders' }),
  ],
  edges: [],
  unit_tests: [{ unique_id: 'unit_test.p.orders.orders_state', name: 'orders_state', model: 'orders', original_file_path: 'models/schema.yml' }],
};

describe('yamlTargetFor', () => {
  it('is null for SQL files and unknown nodes', () => {
    expect(yamlTargetFor(GRAPH, 'models/orders.sql', 'model.p.orders')).toBeNull();
    expect(yamlTargetFor(GRAPH, 'models/schema.yml', 'model.p.nope')).toBeNull();
    expect(yamlTargetFor(GRAPH, 'models/schema.yml', null)).toBeNull();
  });

  it('maps each node type to where it lives in YAML', () => {
    expect(yamlTargetFor(GRAPH, 'models/schema.yml', 'model.p.orders', 'order_id'))
      .toEqual({ kind: 'entry', section: 'models', name: 'orders', column: 'order_id' });
    expect(yamlTargetFor(GRAPH, 'models/schema.yml', 'source.p.raw.orders'))
      .toEqual({ kind: 'entry', section: 'tables', name: 'orders', parent: { section: 'sources', name: 'raw' }, column: null });
    expect(yamlTargetFor(GRAPH, 'models/metrics.yaml', 'metric.p.revenue'))
      .toEqual({ kind: 'entry', section: 'metrics', name: 'revenue', column: null });
    expect(yamlTargetFor(GRAPH, 'models/schema.yml', 'test.p.unique_orders_order_id'))
      .toEqual({ kind: 'test', testMetadataName: 'unique', columnName: 'order_id', attachedNode: 'model.p.orders' });
    expect(yamlTargetFor(GRAPH, 'models/schema.yml', 'unit_test.p.orders.orders_state'))
      .toEqual({ kind: 'unit_test', name: 'orders_state' });
  });
});
