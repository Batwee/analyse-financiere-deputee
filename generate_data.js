const fs = require('fs');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');

const XML_URL = 'https://www.hatvp.fr/livraison/merge/declarations.xml';
const DEPUTES_API_URL = 'https://www.nosdeputes.fr/deputes/json';
const SENATEURS_API_URL = 'https://www.nossenateurs.fr/senateurs/json';
const OUTPUT_FILE = 'hatvp_data.json';

// Table de correspondance pour harmoniser les noms d'entreprises (tout en majuscules)
const COMPANY_RULES = [
  { matches: ["L'OREAL", "L OREAL", "LOREAL"], canonical: "L'OREAL" },
  { matches: ["UNIBAIL-RODAMCO-WESTFIELD", "UNIBAIL RODAMCO", "UNIBAIL-RODAMCO", "UNIBAIL"], canonical: "UNIBAIL-RODAMCO-WESTFIELD" },
  { matches: ["BOUYGUES SA", "BOUYGUES"], canonical: "BOUYGUES" },
  { matches: ["AIR LIQUIDE", "AIR LIQUID"], canonical: "AIR LIQUIDE" },
  { matches: ["SCHNEIDER ELECTRIC", "SCHNEIDER"], canonical: "SCHNEIDER ELECTRIC" },
  { matches: ["BNP PARIBAS", "BNP"], canonical: "BNP PARIBAS" },
  { matches: ["HERMES"], canonical: "HERMES" },
  { matches: ["SANOFI"], canonical: "SANOFI" },
  { matches: ["CREDIT AGRICOLE"], canonical: "CREDIT AGRICOLE" },
  { matches: ["VALLOUREC"], canonical: "VALLOUREC" },
  { matches: ["SAFRAN"], canonical: "SAFRAN" },
  { matches: ["AXA"], canonical: "AXA" },
  { matches: ["THALES"], canonical: "THALES" },
  { matches: ["LVMH"], canonical: "LVMH" },
  { matches: ["DANONE"], canonical: "DANONE" },
  { matches: ["ENGIE"], canonical: "ENGIE" },
  { matches: ["RENAULT"], canonical: "RENAULT" },
  { matches: ["SOPRA STERIA"], canonical: "SOPRA STERIA" },
  { matches: ["NANOBIOTIX"], canonical: "NANOBIOTIX" },
  { matches: ["AIRBUS"], canonical: "AIRBUS" },
  { matches: ["STELLANTIS"], canonical: "STELLANTIS" },
  { matches: ["ORANGE"], canonical: "ORANGE" },
  { matches: ["AIR FRANCE"], canonical: "AIR FRANCE-KLM" },
  { matches: ["EURAZEO"], canonical: "EURAZEO" },
  { matches: ["VINCI"], canonical: "VINCI" },
  { matches: ["SAINT GOBAIN", "SAINT-GOBAIN"], canonical: "SAINT-GOBAIN" },
  { matches: ["ALLIANZ"], canonical: "ALLIANZ" },
  { matches: ["FDJ", "LA FRANCAISE DES JEUX"], canonical: "FDJ" },
  { matches: ["VIVENDI"], canonical: "VIVENDI" },
  { matches: ["ARCELORMITTAL"], canonical: "ARCELORMITTAL" },
  { matches: ["VEOLIA ENVIRONNEMENT", "VEOLIA"], canonical: "VEOLIA" },
  { matches: ["AEROPORTS DE PARIS", "GROUPE ADP", "ADP"], canonical: "GROUPE ADP" },
  { matches: ["PERNOD RICARD", "PERNOD"], canonical: "PERNOD RICARD" },
  { matches: ["MICHELIN"], canonical: "MICHELIN" },
  { matches: ["CHRISTIAN DIOR", "DIOR"], canonical: "CHRISTIAN DIOR" },
  { matches: ["UNIVERSAL MUSIC"], canonical: "UNIVERSAL MUSIC GROUP" },
  { matches: ["MICROSOFT"], canonical: "MICROSOFT" },
  { matches: ["TRIGANO"], canonical: "TRIGANO" },
  { matches: ["ASML"], canonical: "ASML" },
  { matches: ["JCDECAUX"], canonical: "JCDECAUX" },
  { matches: ["ALSTOM"], canonical: "ALSTOM" },
  { matches: ["CARREFOUR"], canonical: "CARREFOUR" },
  { matches: ["KERING"], canonical: "KERING" },
  { matches: ["BIOMERIEUX", "BIOMEDERIEUX"], canonical: "BIOMERIEUX" },
  { matches: ["FNAC DARTY"], canonical: "FNAC DARTY" },
  { matches: ["CELLNEX"], canonical: "CELLNEX TELECOM" },
  { matches: ["APPLE"], canonical: "APPLE" },
  { matches: ["REMY COINTREAU"], canonical: "REMY COINTREAU" },
  { matches: ["STMICROELECTRONICS", "STMICROELECTONICS"], canonical: "STMICROELECTRONICS" },
  { matches: ["SOLVAY"], canonical: "SOLVAY" },
  { matches: ["ARKEMA"], canonical: "ARKEMA" },
  { matches: ["CONTINENTAL"], canonical: "CONTINENTAL" },
  { matches: ["SOCIETE GENERALE", "SCOIETE GENERALE"], canonical: "SOCIETE GENERALE" },
  { matches: ["NEOEN"], canonical: "NEOEN" },
  { matches: ["CAPGEMINI", "CAP GEMINI"], canonical: "CAPGEMINI" },
  { matches: ["COSTCO"], canonical: "COSTCO" },
  { matches: ["NOVO NORDISK"], canonical: "NOVO NORDISK" },
  { matches: ["QUADIENT"], canonical: "QUADIENT" },
  { matches: ["AMD", "ADVANCED MICRO DEVICES"], canonical: "AMD" },
  { matches: ["TF1"], canonical: "TF1" },
  { matches: ["UBER"], canonical: "UBER" },
  { matches: ["EDF"], canonical: "EDF" },
  { matches: ["WORLDLINE"], canonical: "WORLDLINE" },
  { matches: ["PUMA"], canonical: "PUMA" },
  { matches: ["SAMSUNG"], canonical: "SAMSUNG" },
  { matches: ["INTUITIVE SURGICAL"], canonical: "INTUITIVE SURGICAL" },
  { matches: ["RUBIS"], canonical: "RUBIS" },
  { matches: ["NOKIA"], canonical: "NOKIA" },
  { matches: ["EUROTUNNEL", "GETLINK"], canonical: "GETLINK" },
  { matches: ["SERVICENOW"], canonical: "SERVICENOW" },
  { matches: ["SALESFORCE"], canonical: "SALESFORCE" },
  { matches: ["VISA"], canonical: "VISA" },
  { matches: ["ZSCALER"], canonical: "ZSCALER" },
  { matches: ["PUBLICIS"], canonical: "PUBLICIS" },
  { matches: ["CARBIOS"], canonical: "CARBIOS" },
  { matches: ["ESSILORLUXOTTICA", "ESSILOR"], canonical: "ESSILORLUXOTTICA" },
  { matches: ["ROBLOX"], canonical: "ROBLOX" },
  { matches: ["SARTORIUS STEDIM BIOTECH", "SARTORIUS STEDIM", "SARTORIUS"], canonical: "SARTORIUS STEDIM BIOTECH" },
  { matches: ["SEA LIMITED", "SEA SP ADR-A"], canonical: "SEA LIMITED" },
  { matches: ["WENDEL"], canonical: "WENDEL" },
  { matches: ["REDDIT"], canonical: "REDDIT" },
  { matches: ["IONQ"], canonical: "IONQ" },
  { matches: ["DASSAULT SYSTEMES", "DASSAULT"], canonical: "DASSAULT SYSTEMES" },
  { matches: ["MERCEDES-BENZ GROUP", "MERCEDEZ-BENZ", "MERCEDES"], canonical: "MERCEDES-BENZ GROUP" },
  { matches: ["DERICHEBOURG"], canonical: "DERICHEBOURG" },
  { matches: ["UBISOFT"], canonical: "UBISOFT" },
  { matches: ["THYSSENKRUPP"], canonical: "THYSSENKRUPP" },
  { matches: ["FORVIA"], canonical: "FORVIA" },
  { matches: ["GL EVENTS"], canonical: "GL EVENTS" },
  { matches: ["DONTNOD", "DON'T NOD"], canonical: "DONTNOD" },
  { matches: ["DEEZER"], canonical: "DEEZER" },
  { matches: ["EUROAPI"], canonical: "EUROAPI" },
  { matches: ["TELEPERFORMANCE"], canonical: "TELEPERFORMANCE" },
  { matches: ["NICOX"], canonical: "NICOX" },
  { matches: ["VANTIVA"], canonical: "VANTIVA" },
  { matches: ["RALLYE"], canonical: "RALLYE" },
  { matches: ["CASINO-GUICHARD", "CASINO"], canonical: "CASINO" },
  { matches: ["ATARI REGPT", "ATARI"], canonical: "ATARI" }
];

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } 
        catch (e) { reject(e); }
      });
    }).on('error', err => reject(err));
  });
}

function downloadXML(url) {
  return new Promise((resolve, reject) => {
    console.log('Téléchargement du XML HATVP (cela peut prendre quelques secondes)...');
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', err => reject(err));
  });
}

function getString(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return '';
}

function standardizeCompanyName(name) {
  if (!name) return '';

  let n = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
              .replace(/\[DONNEES NON PUBLIEES\]/gi, ' ')
              .replace(/\[DONNÉES NON PUBLIÉES\]/gi, ' ')
              .replace(/[\n\r]/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .toUpperCase();

  // Règle spécifique prioritaire : tout ce qui contient TOTAL devient TOTAL
  if (n.includes('TOTAL')) {
    return 'TOTAL';
  }

  // Vérification dans la table des règles
  for (const rule of COMPANY_RULES) {
    for (const pattern of rule.matches) {
      if (n.includes(pattern)) {
        return rule.canonical;
      }
    }
  }

  return n;
}

function parseNumeric(val) {
  if (val === undefined || val === null || val === '') return 0;
  if (typeof val === 'number') return val;
  
  if (typeof val === 'string') {
    const clean = val.replace(/\s+/g, '').replace(',', '.');
    const match = clean.match(/\d+(\.\d+)?/);
    return match ? parseFloat(match[0]) : 0;
  }
  
  if (typeof val === 'object') {
    if (val.montant !== undefined) return parseNumeric(val.montant);
    if (val.valeur !== undefined) return parseNumeric(val.valeur);
    if (val.evaluation !== undefined) return parseNumeric(val.evaluation);
    
    for (const key of Object.keys(val)) {
      const res = parseNumeric(val[key]);
      if (res > 0) return res;
    }
  }
  return 0;
}

function getEluNom(decla) {
  const declarant = decla?.declarant || decla?.general?.declarant || {};
  let prenom = getString(declarant.prenom || declarant.prenomDeclarant).split(',')[0].trim();
  let nom = getString(declarant.nom || declarant.nomDeclarant).trim();
  
  if (prenom || nom) return `${prenom} ${nom}`.trim();
  return 'Inconnu';
}

function normalizeName(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
}

async function processData() {
  try {
    const parlementairesMap = new Map();
    console.log('Chargement des listes officielles (Députés & Sénateurs)...');
    
    try {
      const depData = await fetchJSON(DEPUTES_API_URL);
      if (depData?.deputes) {
        for (const entry of depData.deputes) {
          const d = entry.depute;
          parlementairesMap.set(normalizeName(d.nom), { 
            parti: d.groupe_sigle || 'Non renseigné',
            type: 'Député'
          });
        }
      }
    } catch (e) { console.warn('Erreur API Députés'); }

    try {
      const senData = await fetchJSON(SENATEURS_API_URL);
      if (senData?.senateurs) {
        for (const entry of senData.senateurs) {
          const s = entry.senateur;
          parlementairesMap.set(normalizeName(s.nom), { 
            parti: s.groupe_sigle || 'Non renseigné',
            type: 'Sénateur'
          });
        }
      }
    } catch (e) { console.warn('Erreur API Sénateurs'); }

    console.log(`-> ${parlementairesMap.size} parlementaires officiels indexés.`);

    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing du document XML...');

    const parser = new XMLParser({
      ignoreAttributes: true,
      parseTagValue: true 
    });

    const parsedObj = parser.parse(xmlText);
    const rootContainer = parsedObj?.declarations || parsedObj;
    let declarations = rootContainer?.declaration || [];
    if (!Array.isArray(declarations)) declarations = [declarations];

    const records = [];
    const setUnique = new Set();
    let countMatched = 0;

    for (const decla of declarations) {
      const eluNom = getEluNom(decla);
      if (!eluNom || eluNom === 'Inconnu') continue;

      const normName = normalizeName(eluNom);
      if (!parlementairesMap.has(normName)) continue;

      countMatched++;
      const apiInfo = parlementairesMap.get(normName);
      const parti = apiInfo.parti;

      const allNodes = [];
      function traverse(node) {
        if (!node || typeof node !== 'object') return;
        allNodes.push(node);
        for (const key of Object.keys(node)) {
          if (typeof node[key] === 'object') traverse(node[key]);
        }
      }
      traverse(decla);

      for (const node of allNodes) {
        const rawNom = getString(node.nomSociete || node.nom_societe || node.denomination);
        const nomSociete = standardizeCompanyName(rawNom);
        
        if (!nomSociete) continue;

        let rawVal = node.evaluation;
        if (rawVal === undefined) rawVal = node.capitalDetenu;
        if (rawVal === undefined) rawVal = node.valeurParticipation;
        
        if (rawVal === undefined) continue;

        const montant = parseNumeric(rawVal);

        if (montant > 0) {
          const uniqueKey = `${eluNom}-${nomSociete}-${montant}`;
          if (setUnique.has(uniqueKey)) continue;
          setUnique.add(uniqueKey);

          records.push({
            entreprise: nomSociete,
            elu: eluNom,
            parti: parti,
            type: apiInfo.type,
            montant: montant
          });
        }
      }
    }

    console.log(`Déclarations de parlementaires trouvées dans la HATVP : ${countMatched}`);
    console.log(`Participations financières extraites (> 0 €) : ${records.length}`);

    if (records.length === 0) {
      throw new Error("Aucune participation > 0 € n'a été extraite.");
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier ${OUTPUT_FILE} généré avec succès (${records.length} entrées).`);

  } catch (error) {
    console.error('Erreur :', error.message);
    process.exit(1);
  }
}

processData();
