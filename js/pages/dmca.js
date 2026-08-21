// Copyright / DMCA page. Static text — the module exists only to hang the
// site header and footer on it, the same as every other page here.
//
// It still calls initSite(), which restores the session: the header shows who
// you are signed in as, and a legal page that forgets you were signed in reads
// as a different site. Nothing on the page depends on the answer.

import { initSite } from '../site.js';

initSite();
