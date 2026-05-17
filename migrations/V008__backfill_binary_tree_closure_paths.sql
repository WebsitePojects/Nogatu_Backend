-- Expand closure rows from direct links into full ancestor-descendant paths.
-- Repeated INSERT IGNORE passes safely converge for normal binary depths.

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;

INSERT IGNORE INTO binary_tree_closuretab (ancestor_uid, descendant_uid, depth, leg)
SELECT c.ancestor_uid, child.uid, c.depth + 1, c.leg
FROM binary_tree_closuretab c
INNER JOIN usertab child ON child.refid = c.descendant_uid
WHERE c.leg <> 'self' AND c.depth < 30;
