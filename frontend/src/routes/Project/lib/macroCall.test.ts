import { describe, expect, it } from 'vitest';
import { buildMacroCall, macroCallName, wrapJinja } from './macroCall';

describe('macroCallName', () => {
  it('leaves root project macros unqualified', () => {
    expect(macroCallName('cents_to_dollars', 'my_proj', 'my_proj', 'duckdb')).toBe('cents_to_dollars');
  });

  it('leaves dbt core and adapter macros unqualified', () => {
    expect(macroCallName('current_timestamp', 'dbt', 'my_proj', 'duckdb')).toBe('current_timestamp');
    expect(macroCallName('duckdb__get_columns', 'dbt_duckdb', 'my_proj', 'duckdb')).toBe('duckdb__get_columns');
    expect(macroCallName('postgres__x', 'dbt_postgres', 'my_proj', 'redshift')).toBe('postgres__x');
  });

  it('namespaces installed package macros', () => {
    expect(macroCallName('star', 'dbt_utils', 'my_proj', 'duckdb')).toBe('dbt_utils.star');
    expect(macroCallName('expect_x', 'dbt_expectations', 'my_proj', 'snowflake')).toBe('dbt_expectations.expect_x');
  });

  it('leaves macros with no package unqualified', () => {
    expect(macroCallName('m', null, 'my_proj', 'duckdb')).toBe('m');
  });
});

describe('buildMacroCall', () => {
  it('builds a call with no args', () => {
    expect(buildMacroCall('dbt_utils.star', {})).toBe('dbt_utils.star()');
  });

  it('builds a multi-line call with args', () => {
    expect(buildMacroCall('dbt_utils.star', { from: "ref('a')", except: '' })).toBe(
      "dbt_utils.star(\n    from=ref('a'),\n    except=''\n)",
    );
  });
});

describe('wrapJinja', () => {
  it('collapses a multi-line call into one expression', () => {
    expect(wrapJinja('x(\n    a=1\n)')).toBe('{{ x( a=1 ) }}');
  });
});
