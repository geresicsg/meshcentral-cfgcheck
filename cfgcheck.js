/**
 * cfgcheck - MeshCentral plugin
 *
 * Egy "Config check" fület ad az eszköz oldalához. A gombra kattintva a plugin
 * egy csak olvasó PowerShell scriptet futtat az ügynökön (a MeshCentral saját
 * "Run commands" funkciójával), majd az eredményt táblázatban kiírja a fülön
 * és egy felugró ablakban is.
 *
 * Jelenleg ellenőrzött beállítások:
 *   - HKLM\SYSTEM\CurrentControlSet\Control\Lsa\LimitBlankPasswordUse
 *   - OpenSSH sshd szolgáltatás állapota
 *   - PermitEmptyPasswords a sshd_config-ban és a sshd -T kimenetében
 *
 * Új ellenőrzés hozzáadása: két helyen kell bővíteni,
 *   1) buildScript(): adj hozzá egy sort, ami "CFGCHECK|kulcs|érték" formátumban ír ki,
 *   2) evaluate():    értelmezd a kulcsot és tegyél be egy sort a rows tömbbe.
 *
 * FONTOS: az obj.exports-ban felsorolt függvényeket a MeshCentral szöveggé
 * alakítja és a böngészőben futtatja. Ezért ezek nem hivatkozhatnak a fájl
 * változóira (obj, parent...), csak a böngésző globáljaira és a
 * pluginHandler.cfgcheck-re.
 */
module.exports.cfgcheck = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;

    // Ezek futnak a böngészőben
    obj.exports = ['onWebUIStartupEnd', 'onDeviceRefreshEnd', 'esc', 'buildScript', 'evaluate', 'render', 'run', 'onResult'];

    obj.server_startup = function () { };

    // ---------------------------------------------------------------------
    // A böngészőben futó rész
    // ---------------------------------------------------------------------

    // Elkapja az ügynök válaszát (a webes felület alapból nem kezeli a runcommands választ)
    obj.onWebUIStartupEnd = function () {
        if (typeof meshserver === 'undefined' || meshserver == null || meshserver._cfgcheckHooked) return;
        meshserver._cfgcheckHooked = true;
        var orig = meshserver.onMessage;
        meshserver.onMessage = function (server, message) {
            if (message && (message.action === 'runcommands' || (message.action === 'msg' && message.type === 'runcommands')) &&
                typeof message.responseid === 'string' && message.responseid.indexOf('cfgcheck:') === 0) {
                try { pluginHandler.cfgcheck.onResult(message); } catch (ex) { console.log('cfgcheck hiba:', ex); }
                return;
            }
            if (orig) return orig.apply(this, arguments);
        };
    };

    // Az eszköz oldalán a fül felépítése
    obj.onDeviceRefreshEnd = function (nodeid, panel, refresh, event) {
        var h = pluginHandler.cfgcheck;
        pluginHandler.registerPluginTab({ tabId: 'pluginCfgCheck', tabTitle: 'Config check' });
        var last = (h.last && currentNode && h.last[currentNode._id]) ? h.last[currentNode._id] : '';
        QH('pluginCfgCheck',
            '<div style="padding:8px">' +
            '<input type="button" id="cfgcheckBtn" value="Ellenőrzés futtatása" onclick="pluginHandler.cfgcheck.run()" />' +
            '<span id="cfgcheckStatus" style="margin-left:10px"></span>' +
            '<div id="cfgcheckResult" style="margin-top:10px">' + last + '</div>' +
            '</div>');
    };

    obj.esc = function (s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    };

    // A távoli gépen futó PowerShell. Minden sor egy utasítás (stdin-en keresztül fut),
    // és csak olvas, semmit nem módosít.
    obj.buildScript = function () {
        var L = [];
        L.push("$ErrorActionPreference = 'SilentlyContinue'");
        // 1) LimitBlankPasswordUse
        L.push("$v = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa' -Name LimitBlankPasswordUse).LimitBlankPasswordUse");
        L.push("Write-Output ('CFGCHECK|LimitBlankPasswordUse|' + $v)");
        // 2) sshd szolgáltatás
        L.push("$s = Get-Service sshd");
        L.push("if ($s) { Write-Output ('CFGCHECK|sshdService|' + $s.Status + '/' + $s.StartType) } else { Write-Output 'CFGCHECK|sshdService|NOTFOUND' }");
        // 3) PermitEmptyPasswords a konfigurációs fájlban
        L.push("$f = Join-Path $env:ProgramData 'ssh\\sshd_config'");
        L.push("if (Test-Path $f) { $m = @(Select-String -Path $f -Pattern '^\\s*PermitEmptyPasswords\\s+\\S+' | ForEach-Object { $_.Line.Trim() }); Write-Output ('CFGCHECK|sshdConfigLines|' + ($m -join ' ; ')) } else { Write-Output 'CFGCHECK|sshdConfigLines|NOFILE' }");
        // 4) Effektív érték (sshd -T a fájlból számolja)
        L.push("$e = @(& (Join-Path $env:windir 'System32\\OpenSSH\\sshd.exe') -T 2>$null | Where-Object { $_ -match '^permitemptypasswords' })");
        L.push("Write-Output ('CFGCHECK|sshdEffective|' + ($e -join ' ; '))");
        return L.join('\r\n');
    };

    // A nyers értékekből sorokat készít. allows: true = az üres jelszót engedi, false = nem engedi, null = nem releváns
    obj.evaluate = function (v) {
        var rows = [], reasons = [];
        var first = function (s) { return String(s || '').split(' ; ')[0].trim(); };

        // LimitBlankPasswordUse
        var lb = (v.LimitBlankPasswordUse == null) ? '' : String(v.LimitBlankPasswordUse).trim();
        var lbAllows = (lb === '0');
        rows.push({
            title: 'Üres jelszó csak konzolon (LimitBlankPasswordUse)',
            value: (lb === '') ? 'nincs beállítva (alapértelmezett: 1)' : (lb + (lb === '0' ? ' (Letiltva)' : ' (Engedélyezve)')),
            allows: lbAllows,
            note: lbAllows ? 'Az üres jelszó hálózaton keresztül is használható.' : 'Üres jelszóval csak a gép konzolján lehet belépni.'
        });
        if (!lbAllows) reasons.push('a LimitBlankPasswordUse nem 0');

        // sshd szolgáltatás
        var svc = String(v.sshdService || '').trim();
        var svcRunning = (svc.indexOf('Running') === 0);
        rows.push({
            title: 'OpenSSH szerver (sshd szolgáltatás)',
            value: (svc === 'NOTFOUND') ? 'nincs telepítve' : (svc || 'ismeretlen'),
            allows: null,
            note: svcRunning ? '' : 'Az sshd nem fut.'
        });
        if (!svcRunning) reasons.push('az sshd nem fut');

        // PermitEmptyPasswords a fájlban
        var cfg = String(v.sshdConfigLines || '').trim();
        var cfgVal = (cfg === '' || cfg === 'NOFILE') ? null : (first(cfg).split(/\s+/)[1] || '').toLowerCase();
        rows.push({
            title: 'PermitEmptyPasswords (sshd_config)',
            value: (cfg === 'NOFILE') ? 'a fájl nem található' : ((cfg === '') ? 'nincs ilyen sor (alapértelmezett: no)' : cfg),
            allows: (cfgVal === 'yes'),
            note: 'Az első előfordulás számít. A Match blokkokon belüli sorokat külön kell nézni.'
        });

        // Effektív érték
        var eff = String(v.sshdEffective || '').trim();
        var effVal = (eff === '') ? null : (first(eff).split(/\s+/)[1] || '').toLowerCase();
        rows.push({
            title: 'PermitEmptyPasswords (effektív, sshd -T)',
            value: (eff === '') ? 'nem olvasható' : first(eff),
            allows: (effVal == null) ? null : (effVal === 'yes'),
            note: 'A fájlból számolt érték, az sshd újraindítása után lesz érvényes.'
        });
        var permit = (effVal != null) ? (effVal === 'yes') : (cfgVal === 'yes');
        if (!permit) reasons.push('a PermitEmptyPasswords nem yes');

        // Összegzés, legfelül
        var works = lbAllows && permit && svcRunning;
        rows.unshift({
            title: 'SFTP belépés üres jelszóval',
            value: works ? 'lehetséges' : 'nem lehetséges',
            allows: works,
            summary: true,
            note: works ? '' : ('Ok: ' + reasons.join(', ') + '.')
        });
        return rows;
    };

    obj.render = function (rows, name) {
        var e = pluginHandler.cfgcheck.esc;
        var td = 'padding:4px 10px;border:1px solid #8886;';
        var out = '<div style="margin-bottom:6px"><b>' + e(name) + '</b> &ndash; ' + e(new Date().toLocaleString()) + '</div>';
        out += '<table style="border-collapse:collapse">';
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            var col = (r.allows === true) ? '#c77700' : ((r.allows === false) ? '#2a8a2a' : 'inherit');
            var mark = (r.allows === null || r.allows === undefined) ? '' : '&#9679; ';
            out += '<tr' + (r.summary ? ' style="font-weight:bold"' : '') + '>' +
                '<td style="' + td + '">' + e(r.title) + '</td>' +
                '<td style="' + td + 'color:' + col + '">' + mark + e(r.value) + '</td>' +
                '<td style="' + td + 'opacity:.75;font-weight:normal">' + e(r.note || '') + '</td></tr>';
        }
        out += '</table>';
        out += '<div style="margin-top:6px;opacity:.7;font-size:90%"><span style="color:#c77700">&#9679;</span> az üres jelszót engedi &nbsp; <span style="color:#2a8a2a">&#9679;</span> nem engedi</div>';
        return out;
    };

    // Futtatás gombra
    obj.run = function () {
        var h = pluginHandler.cfgcheck;
        if (typeof currentNode === 'undefined' || currentNode == null) return;
        var node = currentNode;
        var st = Q('cfgcheckStatus');
        var aid = (node.agent != null) ? node.agent.id : 0;
        var isWin = ((aid > 0) && (aid < 5)) || ((aid > 41) && (aid < 44));
        if (!isWin) { st.textContent = 'Csak Windows ügynökön működik.'; return; }
        if ((node.conn & 1) == 0) { st.textContent = 'Az eszköz ügynöke nincs kapcsolódva.'; return; }

        h.pending = h.pending || {};
        var rid = 'cfgcheck:' + node._id + ':' + Date.now();
        h.pending[rid] = {
            nodeid: node._id,
            name: node.name,
            timer: setTimeout(function () {
                var hh = pluginHandler.cfgcheck;
                if (hh.pending && hh.pending[rid]) {
                    delete hh.pending[rid];
                    var b = Q('cfgcheckBtn'), s = Q('cfgcheckStatus');
                    if (b) b.disabled = false;
                    if (s) s.textContent = 'Időtúllépés: nem jött válasz az ügynöktől (lehet, hogy másik parancs fut).';
                }
            }, 30000)
        };
        st.textContent = 'Futtatás...';
        Q('cfgcheckBtn').disabled = true;
        // type 2 = Windows PowerShell, runAsUser 0 = ügynök (SYSTEM) alatt
        meshserver.send({ action: 'runcommands', nodeids: [node._id], type: 2, cmds: h.buildScript(), runAsUser: 0, reply: true, responseid: rid });
    };

    // Az ügynök válasza
    obj.onResult = function (message) {
        var h = pluginHandler.cfgcheck;
        var p = h.pending ? h.pending[message.responseid] : null;
        if (!p) return;
        clearTimeout(p.timer);
        delete h.pending[message.responseid];

        var btn = Q('cfgcheckBtn'), st = Q('cfgcheckStatus'), box = Q('cfgcheckResult');
        if (btn) btn.disabled = false;

        var res = (typeof message.result === 'string') ? message.result : '';
        var vals = {}, count = 0, lines = res.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i].trim();
            if (l.indexOf('CFGCHECK|') === 0) {
                var parts = l.split('|');
                vals[parts[1]] = parts.slice(2).join('|');
                count++;
            }
        }

        var html;
        if (count === 0) {
            html = '<p style="color:#c00">Nem érkezett értékelhető válasz:</p><pre>' + h.esc(res) + '</pre>';
        } else {
            html = h.render(h.evaluate(vals), p.name);
        }

        h.last = h.last || {};
        h.last[p.nodeid] = html;
        if (box && currentNode && currentNode._id === p.nodeid) box.innerHTML = html;
        if (st) st.textContent = (count === 0) ? 'Hiba' : ('Kész: ' + new Date().toLocaleTimeString());

        // Felugró ablak (ha a felület támogatja)
        try { setDialogMode(2, 'Config check: ' + h.esc(p.name), 1, null, html); } catch (ex) { }
    };

    return obj;
};
