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

// Parcours récursif pour trouver tous les objets contenant 'nomSociete'
function extractParticipations(node) {
  let list = [];
  if (!node) return list;

  if (Array.isArray(node)) {
    for (const item of node) {
      list.push(...extractParticipations(item));
    }
  } else if (typeof node === 'object') {
    if (node.nomSociete) {
      list.push(node);
    } else {
      for (const key of Object.keys(node)) {
        list.push(...extractParticipations(node[key]));
      }
    }
  }
  return list;
}

// Fonction pour déterminer si la déclaration concerne un député
function isDeclarationDepute(decla) {
  const qualiteObj = decla?.qualiteMandat || {};
  const qualiteStr = JSON.stringify(qualiteObj).toLowerCase();
  
  // Vérification de la présence de mots-clés relatifs au mandat de député
  return qualiteStr.includes('depute') || qualiteStr.includes('député') || qualiteStr.includes('députée');
}

async function processData() {
  try {
    const xmlText = await downloadXML(XML_URL);
    console.log('Parsing XML...');

    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => ['declaration', 'items'].includes(name)
    });

    const parsedObj = parser.parse(xmlText);
    const rootContainer = parsedObj?.declarations || parsedObj;
    let declarations = rootContainer?.declaration || [];
    
    if (!Array.isArray(declarations)) {
      declarations = [declarations];
    }

    console.log(`Déclarations trouvées dans le XML : ${declarations.length}`);

    const records = [];
    let countDeputes = 0;

    for (const decla of declarations) {
      if (!isDeclarationDepute(decla)) continue;
      countDeputes++;

      const prenom = String(decla?.declarant?.prenom || '').trim();
      const nom = String(decla?.declarant?.nom || '').trim();
      const eluNom = `${prenom} ${nom}`.trim() || 'Inconnu';

      let parti = String(decla?.qualiteMandat?.organe?.codeOrgane || '').trim();
      if (!parti) {
        parti = String(decla?.qualiteMandat?.labelOrgane || 'Non renseigné').trim();
      }

      const partSection = decla?.participationsFinancieresDto;
      
      // Si la section est absente ou déclarée à "néant"
      if (!partSection || partSection.neant === true || partSection.neant === 'true') {
        continue;
      }

      const items = extractParticipations(partSection);

      for (const item of items) {
        const nomSociete = String(item?.nomSociete || '').trim().toUpperCase();
        
        // L'évaluation peut être sous forme d'une chaîne ou d'un objet (ex: évaluation annuelle)
        let evaluationRaw = item?.evaluation;
        if (typeof evaluationRaw === 'object') {
          evaluationRaw = JSON.stringify(evaluationRaw);
        } else {
          evaluationRaw = String(evaluationRaw || '0').trim();
        }

        if (!nomSociete) continue;

        const cleanVal = evaluationRaw.replace(/\s+/g, '');
        const matches = cleanVal.match(/\d+/);
        const montant = matches ? parseFloat(matches[0]) : 0;

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
      throw new Error("L'extraction a renvoyé 0 résultat. Vérification requise de la structure.");
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(records, null, 2), 'utf-8');
    console.log(`Fichier ${OUTPUT_FILE} mis à jour avec succès (${records.length} entrées).`);

  } catch (error) {
    console.error('Erreur :', error.message);
    process.exit(1);
  }
}

processData();
