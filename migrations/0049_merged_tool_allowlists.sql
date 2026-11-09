-- Agent tool allowlists: the math tools were merged into calculate/statistics and
-- fs_head/fs_tail/fs_wc into fs_read, so allowlists naming the old tools get the new ones.
-- Rollback: not reversible (the merged tools cover the old ones).
UPDATE agents SET tool_allowlist = (
	SELECT json_group_array(name) FROM (
		SELECT DISTINCT CASE
			WHEN value IN ('add', 'subtract', 'multiply', 'divide', 'power', 'sqrt', 'abs', 'round',
				'floor', 'ceil', 'modulo', 'log', 'exp', 'factorial', 'gcd', 'lcm', 'percentage')
				THEN 'calculate'
			WHEN value IN ('min', 'max', 'sum', 'mean', 'median', 'stdev') THEN 'statistics'
			WHEN value IN ('fs_head', 'fs_tail', 'fs_wc') THEN 'fs_read'
			ELSE value
		END AS name
		FROM json_each(agents.tool_allowlist)
	)
)
WHERE tool_allowlist IS NOT NULL
	AND json_valid(tool_allowlist)
	AND json_type(tool_allowlist) = 'array'
	AND EXISTS (
		SELECT 1 FROM json_each(agents.tool_allowlist)
		WHERE value IN ('add', 'subtract', 'multiply', 'divide', 'power', 'sqrt', 'abs', 'round',
			'floor', 'ceil', 'modulo', 'log', 'exp', 'factorial', 'gcd', 'lcm', 'percentage',
			'min', 'max', 'sum', 'mean', 'median', 'stdev', 'fs_head', 'fs_tail', 'fs_wc')
	);
