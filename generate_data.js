const fs = require('fs');
const https = require('https');
const { XMLParser } = require('fast-xml-parser');

const XML_URL = 'https://www.hatvp.fr/livraison/merge/declarations.xml';
const OUTPUT_FILE = 'hatvp_data.json';

function downloadXML(url) {
  return new Promise((resolve, reject) => {
    console.log('Téléchargement du fichier XML HATVP...');
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', err => reject(err));
  });
}

// Recherche récursive universelle de tous les objets ayant une société/organisme
function extractAllParticipations(obj) {
  let results = [];
  if (!obj || typeof obj !== 'object') return results;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      results.push(...extractAllParticipations(item));
    }
  } else {
    // Si l'objet contient un nom de société ou d'organisme
    const nomSociete = obj.nomSociete || obj.nomOrganisme || obj.denomination || obj.nom_societe;
    if (nomSociete && typeof nomSociete === 'string' && nomSociete.trim().length > 0) {
      results.push(obj);
    }

    // Poursuite de la recherche dans les sous-propriétés
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'object') {
        results.push(...extractAllParticipations(obj[key]));
      }
    }
  }
  return results;
}

// Extraction propre du montant numérique
function parseMontant(item) {
  const rawVal = item.evaluation || item.montant || item.valeur || item.remuneration || item.capital || '0';
  const valStr = typeof rawVal === 'object' ? JSON.stringify(rawVal) : String(rawVal);

  const cleanVal = valStr.replace(/\s+/g, '');
  const matches = cleanVal.match(/\d+/);
  return matches ? parseFloat(matches[0]) : 0;
}

function isDepute(decla) {
  const jsonStr = JSON.stringify(decla).toLowerCase();
  return (
    jsonStr.includes('dép') ||
    jsonStr.includes('depu') ||
    jsonStr.includes('mandat parlementaire') ||
    jsonStr.includes('assemblée nationale') ||
    jsonStr.includes('assemblee nationale')
  );
}

async function processData() {
  try {
    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing du document XML...');

    const parser = new XMLParser({
      ignoreAttributes: false,
      parseNodeValue: false,
      isArray: (name) => ['declaration', 'items'].includes(name)
    });

    const parsedObj = parser.parse(xmlText);
    const rootContainer = parsedObj?.declarations || parsedObj;
    let declarations = rootContainer?.declaration || [];

    if (!Array.isArray(declarations)) {
      declarations = [declarations];
    }

    console.log(`Déclarations analysées : ${declarations.length}`);

    const records = [];
    let countDeputes = 0;

    for (const decla of declarations) {
      if (!isDepute(decla)) continue;
      countDeputes++;

      const prenom = String(decla?.declarant?.prenom || '').trim();
      const nom = String(decla?.declarant?.nom || '').trim();
      const eluNom = `${prenom} ${nom}`.trim() || 'Inconnu';

      let parti = String(decla?.qualiteMandat?.organe?.codeOrgane || '').trim();
      if (!parti) {
        parti = String(
          decla?.qualiteMandat?.labelOrgane || 
          decla?.qualiteMandat?.organe?.label || 
          'Non renseigné'
        ).trim();
      }

      // Ciblage de la rubrique participations financières ou recherche globale sur la déclaration
      const partSection = decla?.participationsFinancieresDto || decla;
      const itemsFound = extractAllParticipations(partSection);

      for (const item of itemsFound) {
        const nomSociete = String(
          item.nomSociete || item.nomOrganisme || item.denomination || item.nom_societe || ''
        ).trim().toUpperCase();

        if (!nomSociete) continue;

        const montant = parseMontant(item);

        records.push({
          entreprise: nomSociete,
          elu: eluNom,
          parti: parti,
          montant: montant
        });
      }
    }

    console.log(`Déclarations de députés identifiées : ${countDeputes}`);
    console.log(`Participations financières extraites : ${records.length}`);

    if (records.length === 0) {
      throw new Error("Aucune participation n'a été extraite.");
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier ${OUTPUT_FILE} mis à jour avec succès (${records.length} entrées).`);

  } catch (error) {
    console.error('Erreur :', error.message);
    process.exit(1);
  }
}

processData();
