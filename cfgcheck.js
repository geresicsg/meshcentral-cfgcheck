/**
 * cfgcheck - MeshCentral plugin
 *
 * Egy "Config check" fület ad az eszköz oldalához. A gombra kattintva a plugin
 * egy csak olvasó PowerShell scriptet futtat az ügynökön (a MeshCentral saját
 * "Run commands" funkciójával), az eredményt pedig csoportokba rendezve, keretes
 * táblázatokban kiírja a fülön.
 *
 * Csoportok:
 *   1) SFTP belépés üres jelszóval
 *      - LimitBlankPasswordUse (registry)
 *      - sshd szolgáltatás állapota
 *      - PermitEmptyPasswords a sshd_config-ban és az sshd -T kimenetében
 *   2) Távoli asztal (RDP)
 *      - fDenyTSConnections, TermService, port, NLA, tűzfalszabály,
 *        Remote Desktop Users csoport tagjai, LimitBlankPasswordUse
 *
 * Új ellenőrzés hozzáadása:
 *   1) buildScript(): adj hozzá egy sort, ami "CFGCHECK|kulcs|érték" formátumban ír ki,
 *   2) evaluate():    értelmezd a kulcsot, és tedd be egy csoport rows tömbjébe.
 *      A sor "ok" mezője: true = megfelelő (zöld), false = akadályozza (narancs), null = tájékoztató.
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
        // Közös: LimitBlankPasswordUse
        L.push("$v = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa' -Name LimitBlankPasswordUse).LimitBlankPasswordUse");
        L.push("Write-Output ('CFGCHECK|LimitBlankPasswordUse|' + $v)");
        // SFTP: sshd szolgáltatás
        L.push("$s = Get-Service sshd");
        L.push("if ($s) { Write-Output ('CFGCHECK|sshdService|' + $s.Status + '/' + $s.StartType) } else { Write-Output 'CFGCHECK|sshdService|NOTFOUND' }");
        // SFTP: PermitEmptyPasswords a konfigurációs fájlban
        L.push("$f = Join-Path $env:ProgramData 'ssh\\sshd_config'");
        L.push("if (Test-Path $f) { $m = @(Select-String -Path $f -Pattern '^\\s*PermitEmptyPasswords\\s+\\S+' | ForEach-Object { $_.Line.Trim() }); Write-Output ('CFGCHECK|sshdConfigLines|' + ($m -join ' ; ')) } else { Write-Output 'CFGCHECK|sshdConfigLines|NOFILE' }");
        // SFTP: effektív érték (sshd -T a fájlból számolja)
        L.push("$e = @(& (Join-Path $env:windir 'System32\\OpenSSH\\sshd.exe') -T 2>$null | Where-Object { $_ -match '^permitemptypasswords' })");
        L.push("Write-Output ('CFGCHECK|sshdEffective|' + ($e -join ' ; '))");
        // RDP: engedélyezés (0 = engedélyezve, 1 = tiltva)
        L.push("$ts = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -Name fDenyTSConnections");
        L.push("Write-Output ('CFGCHECK|rdpDeny|' + $ts.fDenyTSConnections)");
        // RDP: NLA és port
        L.push("$rp = Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp'");
        L.push("Write-Output ('CFGCHECK|rdpNLA|' + $rp.UserAuthentication)");
        L.push("Write-Output ('CFGCHECK|rdpPort|' + $rp.PortNumber)");
        // RDP: szolgáltatás
        L.push("$t = Get-Service TermService");
        L.push("if ($t) { Write-Output ('CFGCHECK|rdpService|' + $t.Status + '/' + $t.StartType) } else { Write-Output 'CFGCHECK|rdpService|NOTFOUND' }");
        // RDP: tűzfalszabály (a szabály neve nyelvfüggetlen)
        L.push("$fw = @(Get-NetFirewallRule -Name 'RemoteDesktop-UserMode-In-TCP' | ForEach-Object { [string]$_.Enabled + '/' + [string]$_.Profile })");
        L.push("Write-Output ('CFGCHECK|rdpFirewall|' + ($fw -join ' ; '))");
        // RDP: a Remote Desktop Users csoport tagjai (SID alapján, nyelvfüggetlen)
        L.push("$rg = @(Get-LocalGroupMember -SID 'S-1-5-32-555' | ForEach-Object { $_.Name })");
        L.push("Write-Output ('CFGCHECK|rdpUsers|' + ($rg -join ' ; '))");
        return L.join('\r\n');
    };

    // A nyers értékekből csoportokat és sorokat készít.
    // ok: true = megfelelő (zöld), false = akadályozza (narancs), null = tájékoztató
    obj.evaluate = function (v) {
        var t = function (x) { return (x == null) ? '' : String(x).trim(); };
        var first = function (s) { return String(s || '').split(' ; ')[0].trim(); };
        var svcText = function (s) { return (s === 'NOTFOUND') ? 'nincs telepítve' : (s.replace(/\/$/, '') || 'ismeretlen'); };

        // ---- Közös: LimitBlankPasswordUse ----
        var lb = t(v.LimitBlankPasswordUse);
        var lbOk = (lb === '0');
        var lbRow = function (extra) {
            return {
                title: 'Üres jelszó csak konzolon (LimitBlankPasswordUse)',
                value: (lb === '') ? 'nincs beállítva (alapértelmezett: 1)' : (lb + (lb === '0' ? ' (Letiltva)' : ' (Engedélyezve)')),
                ok: lbOk,
                note: (lbOk ? 'Az üres jelszó hálózaton keresztül is használható.' : 'Üres jelszóval csak a gép konzolján lehet belépni.') + (extra || '')
            };
        };

        // ---- 1) SFTP ----
        var sftp = [], sftpWhy = [];
        sftp.push(lbRow(''));
        if (!lbOk) sftpWhy.push('a LimitBlankPasswordUse nem 0');

        var svc = t(v.sshdService);
        var svcRunning = (svc.indexOf('Running') === 0);
        sftp.push({ title: 'OpenSSH szerver (sshd szolgáltatás)', value: svcText(svc), ok: svcRunning, note: svcRunning ? '' : 'Az sshd nem fut.' });
        if (!svcRunning) sftpWhy.push('az sshd nem fut');

        var cfg = t(v.sshdConfigLines);
        var cfgVal = (cfg === '' || cfg === 'NOFILE') ? null : (first(cfg).split(/\s+/)[1] || '').toLowerCase();
        sftp.push({
            title: 'PermitEmptyPasswords (sshd_config)',
            value: (cfg === 'NOFILE') ? 'a fájl nem található' : ((cfg === '') ? 'nincs ilyen sor (alapértelmezett: no)' : cfg),
            ok: (cfgVal === 'yes'),
            note: 'Az első előfordulás számít. A Match blokkokon belüli sorokat külön kell nézni.'
        });

        var eff = t(v.sshdEffective);
        var effVal = (eff === '') ? null : (first(eff).split(/\s+/)[1] || '').toLowerCase();
        sftp.push({
            title: 'PermitEmptyPasswords (effektív, sshd -T)',
            value: (eff === '') ? 'nem olvasható' : first(eff),
            ok: (effVal == null) ? null : (effVal === 'yes'),
            note: 'A fájlból számolt érték, az sshd újraindítása után lesz érvényes.'
        });
        var permit = (effVal != null) ? (effVal === 'yes') : (cfgVal === 'yes');
        if (!permit) sftpWhy.push('a PermitEmptyPasswords nem yes');

        var sftpWorks = lbOk && permit && svcRunning;
        sftp.unshift({
            title: 'SFTP belépés üres jelszóval',
            value: sftpWorks ? 'lehetséges' : 'nem lehetséges',
            ok: sftpWorks,
            summary: true,
            note: sftpWorks ? '' : ('Ok: ' + sftpWhy.join(', ') + '.')
        });

        // ---- 2) Távoli asztal (RDP) ----
        var rdp = [], rdpWhy = [];

        var deny = t(v.rdpDeny);
        var rdpEnabled = (deny === '0');
        rdp.push({
            title: 'Távoli asztal engedélyezve (fDenyTSConnections)',
            value: (deny === '') ? 'nem olvasható' : (deny + (deny === '0' ? ' (Engedélyezve)' : ' (Tiltva)')),
            ok: (deny === '') ? null : rdpEnabled,
            note: 'Ennek 0-nak kell lennie.'
        });
        if (!rdpEnabled) rdpWhy.push('a Távoli asztal nincs engedélyezve');

        var ts = t(v.rdpService);
        var tsRunning = (ts.indexOf('Running') === 0);
        rdp.push({ title: 'Távoli asztal szolgáltatás (TermService)', value: svcText(ts), ok: tsRunning, note: tsRunning ? '' : 'A szolgáltatás nem fut.' });
        if (!tsRunning) rdpWhy.push('a TermService nem fut');

        var port = t(v.rdpPort);
        rdp.push({
            title: 'Port (PortNumber)',
            value: (port === '') ? 'nem olvasható' : port,
            ok: null,
            note: 'Alapértelmezett: 3389. A kliensben ezt a portot kell megadni.'
        });

        var nla = t(v.rdpNLA);
        rdp.push({
            title: 'Hálózati szintű hitelesítés, NLA (UserAuthentication)',
            value: (nla === '') ? 'nem olvasható' : (nla + (nla === '1' ? ' (Szükséges)' : ' (Nem szükséges)')),
            ok: null,
            note: 'Tájékoztató. Üres jelszavú fióknál, ha a belépés elbukik, ezt is érdemes megnézni.'
        });

        var fw = t(v.rdpFirewall);
        rdp.push({
            title: 'Tűzfalszabály (RemoteDesktop-UserMode-In-TCP)',
            value: (fw === '') ? 'nem olvasható' : (first(fw).indexOf('True') === 0 ? 'Engedélyezve (' + first(fw).split('/')[1] + ')' : 'Letiltva'),
            ok: (fw === '') ? null : (first(fw).indexOf('True') === 0),
            note: 'Csak akkor számít, ha nem a gépen belülről (localhost, pl. MeshCentral Router) csatlakozol.'
        });

        var users = t(v.rdpUsers);
        rdp.push({
            title: 'Remote Desktop Users csoport tagjai',
            value: (users === '') ? '(üres)' : users.split(' ; ').join(', '),
            ok: null,
            note: 'Az Administrators csoport tagjai alapból beléphetnek.'
        });

        rdp.push(lbRow(' Csak üres jelszavú fióknál számít.'));

        var rdpWorks = rdpEnabled && tsRunning;
        rdp.unshift({
            title: 'Távoli asztal (RDP) elérhető',
            value: rdpWorks ? 'igen' : 'nem',
            ok: rdpWorks,
            summary: true,
            note: rdpWorks ? '' : ('Ok: ' + rdpWhy.join(', ') + '.')
        });

        return [
            { title: 'SFTP belépés', rows: sftp },
            { title: 'Távoli asztal (RDP)', rows: rdp }
        ];
    };

    // Csoportonként egy keret, benne egy táblázat
    obj.render = function (sections, name) {
        var e = pluginHandler.cfgcheck.esc;
        var GREEN = '#2a8a2a', ORANGE = '#c77700';
        var td = 'padding:4px 10px;border:1px solid #8886;';
        var out = '<div style="margin-bottom:8px"><b>' + e(name) + '</b> &ndash; ' + e(new Date().toLocaleString()) + '</div>';
        for (var s = 0; s < sections.length; s++) {
            var sec = sections[s];
            out += '<fieldset style="border:1px solid #888a;border-radius:6px;padding:8px 12px 10px 12px;margin:0 0 14px 0">' +
                '<legend style="padding:0 6px;font-weight:bold">' + e(sec.title) + '</legend>' +
                '<table style="border-collapse:collapse">';
            for (var i = 0; i < sec.rows.length; i++) {
                var r = sec.rows[i];
                var col = (r.ok === true) ? GREEN : ((r.ok === false) ? ORANGE : 'inherit');
                var mark = (r.ok === null || r.ok === undefined) ? '' : '&#9679; ';
                out += '<tr' + (r.summary ? ' style="font-weight:bold"' : '') + '>' +
                    '<td style="' + td + '">' + e(r.title) + '</td>' +
                    '<td style="' + td + 'color:' + col + '">' + mark + e(r.value) + '</td>' +
                    '<td style="' + td + 'opacity:.75;font-weight:normal">' + e(r.note || '') + '</td></tr>';
            }
            out += '</table></fieldset>';
        }
        out += '<div style="opacity:.7;font-size:90%"><span style="color:' + GREEN + '">&#9679;</span> megfelelő / használható &nbsp; ' +
            '<span style="color:' + ORANGE + '">&#9679;</span> akadályozza &nbsp; (jelölés nélkül: tájékoztató)</div>';
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
    };

    return obj;
};
