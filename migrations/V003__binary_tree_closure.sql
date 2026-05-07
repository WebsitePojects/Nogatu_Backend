-- Closure table read model for scalable genealogy and upline/downline queries.

CREATE TABLE IF NOT EXISTS binary_tree_closuretab (
  ancestor_uid INT NOT NULL,
  descendant_uid INT NOT NULL,
  depth INT UNSIGNED NOT NULL,
  leg ENUM('left','right','self') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ancestor_uid, descendant_uid),
  KEY idx_descendant (descendant_uid, ancestor_uid),
  KEY idx_ancestor_depth (ancestor_uid, depth),
  KEY idx_ancestor_leg_depth (ancestor_uid, leg, depth)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT uid, uid, 0, 'self'
FROM usertab
WHERE uid IS NOT NULL;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT refid, uid, 1, CASE WHEN position = 1 THEN 'left' ELSE 'right' END
FROM usertab
WHERE refid IS NOT NULL AND refid > 0 AND uid IS NOT NULL AND uid <> refid;
