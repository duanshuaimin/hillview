package org.hiero.sketch.table;

import org.checkerframework.checker.nullness.qual.NonNull;
import org.hiero.sketch.table.api.IndexComparator;

import java.util.List;

public class ListComparator extends IndexComparator {
    @NonNull
    private final List<IndexComparator> comparatorList;

    public ListComparator(@NonNull final List<IndexComparator> comparatorList) {
        this.comparatorList = comparatorList;
    }

    @Override
    public int compare(final Integer o1, final Integer o2) {
        for (final IndexComparator aComparator : this.comparatorList) {
            final int val = aComparator.compare(o1, o2);
            if (val != 0) { return val; }
        }
        return 0;
    }
}