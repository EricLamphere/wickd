import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FolderOpen, Share2 } from 'lucide-react';
import type { DocsMacroDto, DocsNodeDto } from '../../../lib/api';
import { useStickyTab, useUrlTab } from '../../../lib/useUrlTab';
import { startRefactor } from '../lib/refactorEvents';
import { isSemanticType } from '../lib/semantic';
import { ExploreButton, MetricPreview } from '../Metrics/ExploreButton';
import { SemanticDetails } from '../components/SidePane/SemanticDetails';
import { CodeBlock, CodeViewToggle, ColumnsTable, CopyButton, DependsOn, MetaCell, ReferencedBy, Tag } from './DetailParts';
import { useDocsScope, useSelectDocsNode } from './docsScope';

// ---- NodeDetail ----

const CODE_VIEWS = ['source', 'compiled'] as const;

type NodeTab = 'details' | 'description' | 'columns' | 'depends_on' | 'referenced_by' | 'code';

export function NodeDetail({ node, allNodes, allMacros, projectId }: { node: DocsNodeDto; allNodes: Map<string, DocsNodeDto>; allMacros: Map<string, DocsMacroDto>; projectId: number }) {
  const navigate = useNavigate();
  const selectNode = useSelectDocsNode();
  const { canEdit } = useDocsScope();
  const [codeView, setCodeView] = useStickyTab(`docs-code-view:${projectId}`, CODE_VIEWS, 'source');
  const [copied, setCopied] = useState(false);
  const isTest = node.resource_type === 'test';
  const isSemantic = isSemanticType(node.resource_type);
  const hasDependsOn = node.depends_on_nodes.length > 0 || node.depends_on_macros.length > 0;

  const tabs: { id: NodeTab; label: string }[] = [
    { id: 'details', label: 'Details' },
    { id: 'description', label: 'Description' },
    ...(node.columns.length > 0 ? [{ id: 'columns' as NodeTab, label: 'Columns' }] : []),
    ...(hasDependsOn ? [{ id: 'depends_on' as NodeTab, label: 'Depends On' }] : []),
    ...(node.child_models.length > 0 || node.child_tests.length > 0 ? [{ id: 'referenced_by' as NodeTab, label: 'Referenced By' }] : []),
    ...(!isTest && (node.raw_code || node.compiled_code) ? [{ id: 'code' as NodeTab, label: 'Code' }] : []),
  ];
  // ?view= drives the tab; selecting another node drops it, so each node opens on Details
  const [tab, setTab] = useUrlTab<NodeTab>('view', tabs.map((t) => t.id), 'details', null);

  const handleCopy = () => {
    const code = codeView === 'compiled' ? node.compiled_code : node.raw_code;
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-8 pt-6 pb-0 shrink-0 flex items-start justify-between">
        <div>
          <div className="flex items-baseline gap-3 mb-1">
            <h1 className="text-2xl font-semibold text-gray-100 font-mono">{node.name}</h1>
            {node.catalog_type && <span className="text-sm text-gray-500">{node.catalog_type.toLowerCase()}</span>}
            {!node.catalog_type && node.materialized && <span className="text-sm text-gray-500">{node.materialized}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2 mt-1 shrink-0">
          <button
            onClick={() => navigate(`/projects/${projectId}/files?model=${encodeURIComponent(node.unique_id)}`)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-gray-700 bg-surface-elevated hover:bg-gray-700 text-gray-300 transition-colors"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Files
          </button>
          <button
            onClick={() => navigate(`/projects/${projectId}/models?model=${encodeURIComponent(node.unique_id)}`)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded border border-gray-700 bg-surface-elevated hover:bg-gray-700 text-gray-300 transition-colors"
          >
            <Share2 className="w-3.5 h-3.5" />
            DAG
          </button>
        </div>
      </div>
      <div className="px-8 shrink-0">
        <div className="flex items-center gap-0 mt-4 border-b border-gray-800">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-4 py-2 text-sm font-medium transition-colors relative ${tab === t.id ? 'text-brand-300' : 'text-gray-500 hover:text-gray-300'}`}>
              {t.label}
              {tab === t.id && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-brand-400 rounded-t" />}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 py-6">
        {tab === 'details' && (
          <div className="flex flex-col gap-6">
            <section>
              <h2 className="text-sm font-semibold text-gray-200 mb-3">Details</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-x-6 gap-y-3 text-xs">
                <MetaCell label="Tags" value={node.tags.length > 0 ? node.tags.join(', ') : 'untagged'} />
                {node.owner && <MetaCell label="Owner" value={node.owner} />}
                {node.catalog_type && <MetaCell label="Type" value={node.catalog_type} />}
                {node.package_name && <MetaCell label="Package" value={node.package_name} />}
                {node.language && <MetaCell label="Language" value={node.language} />}
                {node.relation_name && <MetaCell label="Relation" value={node.relation_name} />}
                {node.access && <MetaCell label="Access" value={node.access} />}
                {node.group && <MetaCell label="Group" value={node.group} />}
                {node.materialized && <MetaCell label="Materialized" value={node.materialized} />}
                {!isSemantic && <MetaCell label="Contract" value={node.contract ? 'Enforced' : 'Not Enforced'} />}
              </div>
            </section>
            {node.description && (
              <section>
                <h2 className="text-sm font-semibold text-gray-200 mb-2">Description</h2>
                <p className="text-sm text-gray-300 leading-relaxed">{node.description}</p>
              </section>
            )}
            {isSemantic && (
              <section>
                <h2 className="text-sm font-semibold text-gray-200 mb-3">Definition</h2>
                <SemanticDetails resourceType={node.resource_type} name={node.name} label={node.label} semantic={node.semantic} />
                <div className="flex flex-col gap-2 mt-3">
                  <ExploreButton projectId={projectId} resourceType={node.resource_type} name={node.name} grain={node.semantic?.time_granularity} />
                  {node.resource_type === 'metric' && <MetricPreview projectId={projectId} metric={node.name} grain={node.semantic?.time_granularity} />}
                </div>
              </section>
            )}
            {node.columns.length > 0 && (
              <section>
                <h2 className="text-sm font-semibold text-gray-200 mb-3">Columns</h2>
                <ColumnsTable columns={node.columns} compact />
              </section>
            )}
            {hasDependsOn && (
              <section>
                <h2 className="text-sm font-semibold text-gray-200 mb-3">Depends On</h2>
                <DependsOn projectId={projectId} dependsOnNodes={node.depends_on_nodes} dependsOnMacros={node.depends_on_macros} allNodes={allNodes} allMacros={allMacros} onSelectNode={selectNode} />
              </section>
            )}
            {(node.child_models.length > 0 || node.child_tests.length > 0) && (
              <section>
                <h2 className="text-sm font-semibold text-gray-200 mb-3">Referenced By</h2>
                <ReferencedBy projectId={projectId} childModels={node.child_models} childTests={node.child_tests} allNodes={allNodes} onSelect={selectNode} />
              </section>
            )}
            {!isTest && (node.raw_code || node.compiled_code) && (
              <section>
                <div className="flex items-center gap-3 mb-2">
                  <h2 className="text-sm font-semibold text-gray-200">Code</h2>
                  <CodeViewToggle value={codeView} onChange={setCodeView} />
                  <CopyButton copied={copied} onCopy={handleCopy} />
                </div>
                <CodeBlock code={codeView === 'compiled' ? node.compiled_code : node.raw_code} placeholder={`No ${codeView} SQL available.`} />
              </section>
            )}
          </div>
        )}
        {tab === 'description' && (
          <div className="flex flex-col gap-4 max-w-2xl">
            <h2 className="text-sm font-semibold text-gray-200">Description</h2>
            {node.description
              ? <p className="text-sm text-gray-300 leading-relaxed">{node.description}</p>
              : <p className="text-sm text-gray-600 italic">No description provided.</p>}
            {node.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {node.tags.map((t) => <Tag key={t} label={`#${t}`} />)}
              </div>
            )}
          </div>
        )}
        {tab === 'columns' && (
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-gray-200">Columns <span className="font-normal text-gray-600">({node.columns.length})</span></h2>
            <ColumnsTable
              columns={node.columns}
              onRename={canEdit && node.resource_type === 'model' && node.language !== 'python'
                ? (column) => startRefactor({ op: 'rename_column', uniqueId: node.unique_id, model: node.name, column })
                : undefined}
            />
          </div>
        )}
        {tab === 'depends_on' && (
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-gray-200">Depends On</h2>
            <DependsOn projectId={projectId} dependsOnNodes={node.depends_on_nodes} dependsOnMacros={node.depends_on_macros} allNodes={allNodes} allMacros={allMacros} onSelectNode={selectNode} />
          </div>
        )}
        {tab === 'referenced_by' && (
          <div className="flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-gray-200">Referenced By</h2>
            <ReferencedBy projectId={projectId} childModels={node.child_models} childTests={node.child_tests} allNodes={allNodes} onSelect={selectNode} />
          </div>
        )}
        {tab === 'code' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold text-gray-200">Code</h2>
              <CodeViewToggle value={codeView} onChange={setCodeView} />
              <CopyButton copied={copied} onCopy={handleCopy} />
            </div>
            <CodeBlock code={codeView === 'compiled' ? node.compiled_code : node.raw_code} placeholder={`No ${codeView} SQL available.`} />
          </div>
        )}
      </div>
    </div>
  );
}
