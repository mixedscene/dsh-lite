package org.chatbox.antigravity;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;
import java.io.File;
import java.nio.file.Files;

public class DocumentSaverTest {
    @Rule public TemporaryFolder temporary = new TemporaryFolder();
    @Test public void permitsExistingCacheFilesWithUriOrAbsolutePath() throws Exception {
        File cache = temporary.newFolder("cache");
        File source = new File(cache, "export with spaces.json"); assertTrue(source.createNewFile());
        assertEquals(source.getCanonicalFile(), DocumentSaverPlugin.cacheSource(cache, source.toURI().toString()));
        assertEquals(source.getCanonicalFile(), DocumentSaverPlugin.cacheSource(cache, source.getAbsolutePath()));
    }
    @Test public void rejectsPrivateFilesMissingSourcesAndTraversal() throws Exception {
        File cache = temporary.newFolder("cache"), secret = temporary.newFile("private.json");
        File sibling = temporary.newFolder("cache-other"), outside = new File(sibling, "outside.json"); assertTrue(outside.createNewFile());
        for (String source : new String[]{secret.toURI().toString(), outside.toURI().toString(), new File(cache, "../private.json").getPath(), new File(cache, "missing.json").getPath(), "content://other.provider/private", "file://other-host/cache/export.json"}) {
            try { DocumentSaverPlugin.cacheSource(cache, source); fail("Expected noncache rejection"); }
            catch (IllegalArgumentException expected) { }
        }
        File link = new File(cache, "escaped.json"); Files.createSymbolicLink(link.toPath(), secret.toPath());
        try { DocumentSaverPlugin.cacheSource(cache, link.toURI().toString()); fail("Expected symlink rejection"); }
        catch (IllegalArgumentException expected) { }
    }
}
